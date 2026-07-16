# Silent video media fixtures

`synthetic-av.mp4` is generated entirely from FFmpeg's built-in `color` and `sine` filters. It
contains a 16x16 red H.264 video track and a short AAC audio track, with no third-party media.

Regenerate it with:

```bash
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i color=c=red:s=16x16:d=0.4:r=5 \
  -f lavfi -i sine=frequency=1000:duration=0.4 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart \
  -y src/silent-video/__fixtures__/synthetic-av.mp4
```
