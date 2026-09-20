using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.ClipExport.Configuration;

/// <summary>
/// Plugin configuration.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PluginConfiguration"/> class.
    /// </summary>
    public PluginConfiguration()
    {
        MaxClipSeconds = 1800;
        CutMode = "copy";
        EncodePreset = "veryfast";
        EncodeCrf = 18;
    }

    /// <summary>
    /// Gets or sets the longest clip the server will produce, in seconds.
    /// </summary>
    public int MaxClipSeconds { get; set; }

    /// <summary>
    /// Gets or sets the cut mode: "copy" for a lossless stream copy, or
    /// "exact" to re-encode so the clip starts precisely on the in-point.
    /// </summary>
    public string CutMode { get; set; }

    /// <summary>
    /// Gets or sets the x264 preset used when <see cref="CutMode"/> is "exact".
    /// </summary>
    public string EncodePreset { get; set; }

    /// <summary>
    /// Gets or sets the x264 CRF used when <see cref="CutMode"/> is "exact".
    /// </summary>
    public int EncodeCrf { get; set; }
}
