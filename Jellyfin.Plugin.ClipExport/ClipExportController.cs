using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ClipExport;

/// <summary>
/// Cuts a clip out of a library item and streams it back to the caller.
///
/// This runs on the SERVER, which is the whole point: the file is already
/// on local disk and the bundled ffmpeg has no browser memory limits. The
/// earlier client-side attempt foundered on exactly those limits -- a Blob
/// the size of a 1.5GB film cannot be read in the browser at all.
/// </summary>
[ApiController]
[Authorize(Policy = Policies.Download)]
[Route("ClipExport")]
public class ClipExportController : ControllerBase
{
    private readonly ILibraryManager _libraryManager;
    private readonly IMediaEncoder _mediaEncoder;
    private readonly ILogger<ClipExportController> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="ClipExportController"/> class.
    /// </summary>
    /// <param name="libraryManager">Instance of the <see cref="ILibraryManager"/> interface.</param>
    /// <param name="mediaEncoder">Instance of the <see cref="IMediaEncoder"/> interface.</param>
    /// <param name="logger">Instance of the <see cref="ILogger{ClipExportController}"/> interface.</param>
    public ClipExportController(
        ILibraryManager libraryManager,
        IMediaEncoder mediaEncoder,
        ILogger<ClipExportController> logger)
    {
        _libraryManager = libraryManager;
        _mediaEncoder = mediaEncoder;
        _logger = logger;
    }

    /// <summary>
    /// Cuts the requested range out of an item and returns it as a download.
    /// </summary>
    /// <param name="itemId">The library item to cut from.</param>
    /// <param name="start">In-point, in seconds.</param>
    /// <param name="end">Out-point, in seconds.</param>
    /// <param name="mode">"copy" (default) or "exact"; falls back to the configured mode.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The cut clip as a file download.</returns>
    [HttpGet("Clip")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> GetClip(
        [FromQuery, Required] Guid itemId,
        [FromQuery, Required] double start,
        [FromQuery, Required] double end,
        [FromQuery] string? mode,
        CancellationToken cancellationToken)
    {
        var config = Plugin.Instance?.Configuration ?? new Configuration.PluginConfiguration();

        if (end <= start)
        {
            return BadRequest("end must be greater than start");
        }

        var duration = end - start;
        if (duration > config.MaxClipSeconds)
        {
            return BadRequest(string.Format(
                CultureInfo.InvariantCulture,
                "Clip is {0:F0}s; the configured limit is {1}s",
                duration,
                config.MaxClipSeconds));
        }

        if (_libraryManager.GetItemById(itemId) is not BaseItem item)
        {
            return NotFound("Unknown item");
        }

        var sourcePath = item.Path;
        if (string.IsNullOrEmpty(sourcePath) || !System.IO.File.Exists(sourcePath))
        {
            return NotFound("Item has no readable file on disk");
        }

        var cutMode = string.IsNullOrEmpty(mode) ? config.CutMode : mode;
        var isExact = string.Equals(cutMode, "exact", StringComparison.OrdinalIgnoreCase);

        /*
         * In copy mode the streams are untouched, so the source container
         * is always a legal target. In exact mode the output is H.264/AAC,
         * which WebM cannot carry (VP8/VP9/Opus only), so fall back to MKV.
         */
        var sourceExt = Path.GetExtension(sourcePath).TrimStart('.').ToLowerInvariant();
        if (string.IsNullOrEmpty(sourceExt))
        {
            sourceExt = "mkv";
        }

        var outputExt = isExact && string.Equals(sourceExt, "webm", StringComparison.Ordinal)
            ? "mkv"
            : sourceExt;

        var tempPath = Path.Combine(
            Path.GetTempPath(),
            string.Format(CultureInfo.InvariantCulture, "jf-clip-{0:N}.{1}", Guid.NewGuid(), outputExt));

        var args = BuildArguments(sourcePath, tempPath, start, duration, isExact, config);

        _logger.LogInformation(
            "Cutting clip from {ItemName}: {Start}s to {End}s ({Mode})",
            item.Name,
            start,
            end,
            isExact ? "exact" : "copy");

        try
        {
            var exitCode = await RunFfmpegAsync(args, cancellationToken).ConfigureAwait(false);
            if (exitCode != 0)
            {
                _logger.LogError("ffmpeg exited with code {ExitCode}", exitCode);
                TryDelete(tempPath);
                return StatusCode(StatusCodes.Status500InternalServerError, "ffmpeg failed");
            }

            if (!System.IO.File.Exists(tempPath) || new FileInfo(tempPath).Length == 0)
            {
                TryDelete(tempPath);
                return StatusCode(StatusCodes.Status500InternalServerError, "ffmpeg produced an empty file");
            }

            var fileName = BuildFileName(item, start, end, outputExt);

            /*
             * Hand the stream to ASP.NET and let it delete the temp file
             * once the response has been written -- returning the bytes
             * eagerly would defeat the point of doing this server-side.
             */
            var stream = new FileStream(
                tempPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 81920,
                FileOptions.Asynchronous | FileOptions.DeleteOnClose);

            return File(stream, "application/octet-stream", fileName);
        }
        catch (OperationCanceledException)
        {
            TryDelete(tempPath);
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Clip export failed");
            TryDelete(tempPath);
            return StatusCode(StatusCodes.Status500InternalServerError, ex.Message);
        }
    }

    private static IReadOnlyList<string> BuildArguments(
        string sourcePath,
        string outputPath,
        double start,
        double duration,
        bool isExact,
        Configuration.PluginConfiguration config)
    {
        var ss = start.ToString("F3", CultureInfo.InvariantCulture);
        var t = duration.ToString("F3", CultureInfo.InvariantCulture);

        if (!isExact)
        {
            /*
             * Input seek (-ss before -i) with -t for the length. The cut
             * starts at the keyframe at or before the in-point, so the clip
             * can begin up to one keyframe interval early and run that much
             * longer. That is extra real footage, not dead video.
             */
            return new[]
            {
                "-hide_banner", "-loglevel", "warning", "-y",
                "-ss", ss,
                "-i", sourcePath,
                "-t", t,
                "-c", "copy",
                "-avoid_negative_ts", "make_zero",
                "-map", "0",
                // Subtitle/data streams frequently cannot be copied into
                // the output cleanly; drop them rather than fail.
                "-dn",
                "-map", "-0:s?",
                outputPath
            };
        }

        return new[]
        {
            "-hide_banner", "-loglevel", "warning", "-y",
            "-ss", ss,
            "-i", sourcePath,
            "-t", t,
            "-c:v", "libx264",
            "-preset", config.EncodePreset,
            "-crf", config.EncodeCrf.ToString(CultureInfo.InvariantCulture),
            // 10-bit and other exotic pixel formats produce files many
            // players refuse; normalise to the widely supported one.
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "192k",
            "-avoid_negative_ts", "make_zero",
            "-map", "0:v:0?",
            "-map", "0:a:0?",
            "-dn",
            "-sn",
            outputPath
        };
    }

    private async Task<int> RunFfmpegAsync(IReadOnlyList<string> args, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = _mediaEncoder.EncoderPath,
            UseShellExecute = false,
            RedirectStandardError = true,
            CreateNoWindow = true
        };

        foreach (var arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.Start();

        var stderr = await process.StandardError.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
        await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);

        if (process.ExitCode != 0 && !string.IsNullOrWhiteSpace(stderr))
        {
            _logger.LogError("ffmpeg: {Error}", stderr.Trim());
        }

        return process.ExitCode;
    }

    private static string BuildFileName(BaseItem item, double start, double end, string ext)
    {
        var label = item.Name ?? "Clip";

        if (item is MediaBrowser.Controller.Entities.TV.Episode episode)
        {
            label = string.Format(
                CultureInfo.InvariantCulture,
                "{0} - S{1:D2}E{2:D2} - {3}",
                episode.SeriesName,
                episode.ParentIndexNumber ?? 0,
                episode.IndexNumber ?? 0,
                episode.Name);
        }
        else if (item.ProductionYear.HasValue)
        {
            label = string.Format(CultureInfo.InvariantCulture, "{0} ({1})", label, item.ProductionYear.Value);
        }

        label = label.Replace(':', '-');
        foreach (var c in Path.GetInvalidFileNameChars())
        {
            label = label.Replace(c.ToString(), string.Empty, StringComparison.Ordinal);
        }

        return string.Format(
            CultureInfo.InvariantCulture,
            "{0} - clip {1} to {2}.{3}",
            label.Trim(),
            FormatTimestamp(start),
            FormatTimestamp(end),
            ext);
    }

    private static string FormatTimestamp(double seconds)
    {
        var ts = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return ts.TotalHours >= 1
            ? string.Format(CultureInfo.InvariantCulture, "{0}-{1:D2}-{2:D2}", (int)ts.TotalHours, ts.Minutes, ts.Seconds)
            : string.Format(CultureInfo.InvariantCulture, "{0:D2}-{1:D2}", ts.Minutes, ts.Seconds);
    }

    private void TryDelete(string path)
    {
        try
        {
            if (System.IO.File.Exists(path))
            {
                System.IO.File.Delete(path);
            }
        }
        catch (IOException ex)
        {
            _logger.LogWarning(ex, "Could not delete temp file {Path}", path);
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogWarning(ex, "Could not delete temp file {Path}", path);
        }
    }
}
