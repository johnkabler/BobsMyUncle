# bmu explainer video

`bmu-explainer.mp4` — 4:45, 1080p30, with an original procedurally generated synthwave soundtrack.

Covers: who Uncle Bob is, why clean code matters, the metrics bmu tracks (cyclomatic complexity, coverage,
CRAP, mutation testing, the Dependency Rule, import cycles, Martin's package metrics), how bmu works, and how
agents in OpenCode and Grok Build use it.

Rebuild (macOS fonts, Python with Pillow/numpy/scipy, ffmpeg):

```sh
python3 music.py 285 /tmp/music.wav
python3 render.py /tmp/silent.mp4
ffmpeg -i /tmp/silent.mp4 -i /tmp/music.wav -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart bmu-explainer.mp4
python3 render.py --still 8 18 /tmp/crap.png   # preview one frame: scene index, seconds
```
