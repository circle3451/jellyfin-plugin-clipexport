/*
 * Jellyfin VideoOSD Clip Export Button (v2 -- server-side)
 *
 * Adds "Set In", "Set Out" and "Export Clip" buttons to the Jellyfin Web
 * video OSD. The SERVER cuts the requested range out of the original file
 * with its own ffmpeg and sends it back as a download, so it lands in the
 * system Downloads folder.
 *
 * Requires the Jellyfin.Plugin.ClipExport server plugin, which provides
 * the /ClipExport/Clip endpoint this script calls.
 *
 * Why server-side: v1 did the cut in the browser with ffmpeg.wasm, which
 * works for small files but cannot handle a feature film. Measured in
 * Chrome: ffmpeg's wasm filesystem refuses a write above ~1.5GB, and a
 * Blob the size of a 1.5GB film is unreadable outright -- even a 64KB
 * read from it throws NotReadableError. The server has the file on local
 * disk and a real ffmpeg, so none of that applies.
 *
 * Licence: MIT
 */

function clipIsSupportedPlatform() {
    const ua = navigator.userAgent.toLowerCase();
    const isMobile = ['mobi', 'ipad', 'iphone', 'ipod', 'silk', 'opera mini'].some((term) => ua.includes(term));
    const isTv = ['tv', 'samsungbrowser', 'viera', 'web0s'].some((term) => ua.includes(term));
    const isTizen = ua.includes('tizen') || window.tizen != null;
    const isAndroid = ua.includes('android');
    const isIOS = ['ipad', 'iphone', 'ipod'].some((term) => ua.includes(term)) || (ua.includes('macintosh') && navigator.maxTouchPoints > 1);
    return !(isMobile || isTv || isTizen || isAndroid || isIOS);
}

(function () {
    'use strict';

    if (!clipIsSupportedPlatform()) return;

    const LOG = '[VideoOSD Clip Export]';

    const CONFIG = {
        /*
         * Cut mode passed to the server, overriding its configured
         * default. 'copy' is a lossless stream copy that starts at the
         * keyframe at or before the in-point, so the clip can begin up
         * to a keyframe interval early. 'exact' re-encodes to start
         * precisely, which is much slower. null uses the server's
         * dashboard setting.
         */
        cutMode: null,

        // Include the production year for movies in the filename shown
        // while the export runs. The server names the actual file.
        includeYear: true
    };

    let inPoint = null;
    let outPoint = null;
    let busy = false;
    let enabled = false;
    let observer = null;
    let pollInterval = null;
    let lastVideoRef = null;

    const fmtTime = (seconds) => {
        if (seconds == null || !isFinite(seconds)) return '--:--';
        const s = Math.max(0, Math.floor(seconds));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
    };

    const ensureStyles = () => {
        if (document.getElementById('clipExportStyles')) return;
        const style = document.createElement('style');
        style.id = 'clipExportStyles';
        style.textContent = `
            /*
             * clip-armed goes on the IN/OUT buttons once a mark is set,
             * so the selector must cover those, not the export button.
             */
            .btnClipIn.clip-armed .material-icons,
            .btnClipOut.clip-armed .material-icons { color: #f5c518; }
            .btnClipExport.clip-busy .material-icons {
                animation: clipExportSpin 1s linear infinite;
            }
            @keyframes clipExportSpin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
            .clipExportStatus {
                display: inline-flex;
                align-items: center;
                font-size: 0.9em;
                opacity: 0.85;
                margin: 0 0.4em;
                white-space: nowrap;
            }
        `;
        document.head.appendChild(style);
    };

    // ---------------------------------------------------------------
    // Current item
    // ---------------------------------------------------------------

    const getCurrentItemId = () => {
        const ratingBtn = document.querySelector('#videoOsdPage:not(.hide) .btnUserRating');
        return ratingBtn?.dataset?.id || null;
    };

    // ---------------------------------------------------------------
    // Export
    // ---------------------------------------------------------------

    const exportClip = async (setStatus) => {
        if (inPoint == null || outPoint == null) {
            throw new Error('Set both an in-point and an out-point first');
        }
        if (outPoint <= inPoint) {
            throw new Error('Out-point must be after the in-point');
        }

        const itemId = getCurrentItemId();
        if (!itemId) throw new Error('Could not determine the current item');

        const params = new URLSearchParams({
            itemId,
            start: inPoint.toFixed(3),
            end: outPoint.toFixed(3)
        });
        if (CONFIG.cutMode) params.set('mode', CONFIG.cutMode);

        const url = `${ApiClient.serverAddress()}/ClipExport/Clip?${params.toString()}`;

        setStatus('Cutting...');

        /*
         * Authenticated fetch rather than a plain link: the endpoint sits
         * behind Jellyfin's Download policy, so it needs the access token.
         * ApiClient.fetch adds the auth header for us.
         */
        const response = await fetch(url, {
            headers: { Authorization: getAuthHeader() }
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(detail || `Server returned ${response.status}`);
        }

        // Prefer the filename the server chose.
        let filename = null;
        const disposition = response.headers.get('Content-Disposition');
        if (disposition) {
            const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
            if (match) filename = decodeURIComponent(match[1]);
        }
        if (!filename) {
            filename = `clip ${fmtTime(inPoint)} to ${fmtTime(outPoint)}`.replace(/:/g, '-');
        }

        setStatus('Saving...');
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

        return filename;
    };

    /*
     * Build the Authorization header Jellyfin expects. ApiClient exposes
     * the pieces but not always a ready-made header, so assemble it.
     */
    const getAuthHeader = () => {
        const token = ApiClient.accessToken();
        const deviceId = typeof ApiClient.deviceId === 'function' ? ApiClient.deviceId() : '';
        return `MediaBrowser Client="Jellyfin Web", Device="Browser", DeviceId="${deviceId}", Version="1", Token="${token}"`;
    };

    // ---------------------------------------------------------------
    // Buttons
    // ---------------------------------------------------------------

    /*
     * Jellyfin bundles material-design-icons-iconfont (the older
     * "Material Icons" set) and names the glyph as a CLASS on an EMPTY
     * span, exactly as its own OSD markup does:
     *
     *   <span class="xlargePaperIconButton material-icons favorite"></span>
     *
     * Writing the ligature as text into a `material-symbols-outlined`
     * span renders the literal word ("content_cut") on a stock install,
     * because that font is not present.
     */
    const makeButton = (className, icon, title) => {
        const btn = document.createElement('button');
        btn.className = `${className} autoSize paper-icon-button-light`;
        btn.title = title;
        btn.setAttribute('type', 'button');
        const span = document.createElement('span');
        span.className = `xlargePaperIconButton material-icons ${icon}`;
        span.setAttribute('aria-hidden', 'true');
        btn.appendChild(span);
        return btn;
    };

    const getStatusEl = () => document.querySelector('.clipExportStatus');

    const updateStatusLabel = () => {
        const el = getStatusEl();
        if (!el || busy) return;
        if (inPoint == null && outPoint == null) {
            el.textContent = '';
            return;
        }
        el.textContent = `${inPoint != null ? fmtTime(inPoint) : '--:--'} → ${outPoint != null ? fmtTime(outPoint) : '--:--'}`;
    };

    const setStatus = (text) => {
        const el = getStatusEl();
        if (el) el.textContent = text;
    };

    const refreshArmedState = () => {
        const inBtn = document.querySelector('.btnClipIn');
        const outBtn = document.querySelector('.btnClipOut');
        if (inBtn) inBtn.classList.toggle('clip-armed', inPoint != null);
        if (outBtn) outBtn.classList.toggle('clip-armed', outPoint != null);
    };

    const onSetIn = () => {
        const video = document.querySelector('video');
        if (!video) return;
        inPoint = video.currentTime;
        if (outPoint != null && outPoint <= inPoint) outPoint = null;
        refreshArmedState();
        updateStatusLabel();
    };

    const onSetOut = () => {
        const video = document.querySelector('video');
        if (!video) return;
        outPoint = video.currentTime;
        if (inPoint != null && outPoint <= inPoint) {
            setStatus('Out must be after in');
            outPoint = null;
            setTimeout(updateStatusLabel, 2000);
            return;
        }
        refreshArmedState();
        updateStatusLabel();
    };

    const onExport = async () => {
        if (busy) return;
        const exportBtn = document.querySelector('.btnClipExport');

        busy = true;
        if (exportBtn) exportBtn.classList.add('clip-busy');

        try {
            const filename = await exportClip(setStatus);
            setStatus('Saved');
            console.log(`${LOG} exported: ${filename}`);
            inPoint = null;
            outPoint = null;
            refreshArmedState();
            setTimeout(updateStatusLabel, 3000);
        } catch (err) {
            console.error(`${LOG} export failed:`, err);
            setStatus(err.message || 'Export failed');
            setTimeout(updateStatusLabel, 5000);
        } finally {
            busy = false;
            if (exportBtn) exportBtn.classList.remove('clip-busy');
        }
    };

    const injectButtons = () => {
        if (!enabled) return false;

        const favBtn = document.querySelector('.buttons.focuscontainer-x > .btnUserRating');
        if (!favBtn || !favBtn.parentNode) return false;

        const container = favBtn.parentNode;
        if (container.querySelector('.btnClipExport')) return true;

        ensureStyles();

        // Verified present in material-design-icons-iconfont 6.7.0, the
        // package jellyfin-web depends on.
        const inBtn = makeButton('btnClipIn', 'first_page', 'Set clip in-point');
        const outBtn = makeButton('btnClipOut', 'last_page', 'Set clip out-point');
        const exportBtn = makeButton('btnClipExport', 'content_cut', 'Export clip to Downloads');

        inBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onSetIn();
        });
        outBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onSetOut();
        });
        exportBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onExport();
        });

        const status = document.createElement('span');
        status.className = 'clipExportStatus';

        container.insertBefore(inBtn, favBtn);
        container.insertBefore(outBtn, favBtn);
        container.insertBefore(exportBtn, favBtn);
        container.insertBefore(status, favBtn);

        refreshArmedState();
        updateStatusLabel();
        return true;
    };

    // Reset the marks when the playing video changes (next episode,
    // shuffle, autoplay) so points from a previous title cannot leak.
    const checkVideoChange = () => {
        const video = document.querySelector('video');
        if (video !== lastVideoRef) {
            lastVideoRef = video;
            if (!busy) {
                inPoint = null;
                outPoint = null;
                refreshArmedState();
                updateStatusLabel();
            }
        }
    };

    const enable = () => {
        if (enabled) return;
        enabled = true;

        // Debounced: Jellyfin mutates the OSD progress bar constantly
        // during playback, so an undebounced observer would run this
        // callback thousands of times per second.
        let debounceTimer = null;
        observer = new MutationObserver(() => {
            if (debounceTimer) return;
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                injectButtons();
                checkVideoChange();
            }, 100);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class']
        });

        pollInterval = setInterval(() => {
            if (injectButtons()) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
        }, 300);
    };

    enable();
    console.log(`${LOG} Script loaded (server-side v2).`);
})();
