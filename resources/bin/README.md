# Bundled tool directory

Drop `ffmpeg.exe`, `ffprobe.exe` and `yt-dlp.exe` here to ship them with the
installer. Ripper Clipper looks in this folder first, then on the system `PATH`,
then in the usual install locations, and finally uses the paths configured in
Settings → Advanced.

The folder may be left empty: the app detects and reports missing tools rather
than assuming they exist.
