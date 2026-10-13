"""Procedurally composed synthwave soundtrack for the bmu explainer (original, royalty-free).

96 BPM (one bar = 2.5 s), A minor, progression Am - F - C - G.
Usage: python3 music.py <seconds> <out.wav>
"""
import sys
import numpy as np
from scipy.signal import butter, sosfilt
from scipy.io import wavfile

SR = 44100
BPM = 96
BEAT = 60 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(7)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def lp(x, fc, order=2):
    return sosfilt(butter(order, fc, 'low', fs=SR, output='sos'), x)


def hp(x, fc, order=2):
    return sosfilt(butter(order, fc, 'high', fs=SR, output='sos'), x)


def saw(f, n, phase=0.0):
    t = np.arange(n) / SR
    return 2 * ((f * t + phase) % 1.0) - 1


def square(f, n, duty=0.5):
    t = np.arange(n) / SR
    return np.where((f * t) % 1.0 < duty, 1.0, -1.0)


def env_adsr(n, a, d, s, r):
    e = np.ones(n) * s
    A, D, R = int(a * SR), int(d * SR), int(r * SR)
    A = min(A, n)
    e[:A] = np.linspace(0, 1, A, endpoint=False)
    D2 = min(D, n - A)
    e[A:A + D2] = np.linspace(1, s, D2, endpoint=False)
    if R and n > R:
        e[-R:] *= np.linspace(1, 0, R)
    return e


def add(buf, start, sig):
    i = int(start * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i]


# chords: (root midi, notes)
CHORDS = [
    (45, [57, 60, 64]),  # Am
    (41, [53, 57, 60]),  # F
    (48, [55, 60, 64]),  # C
    (43, [55, 59, 62]),  # G
]


def render(seconds):
    n = int(seconds * SR)
    pad = np.zeros(n)
    bass = np.zeros(n)
    arp = np.zeros(n)
    drums = np.zeros(n)
    lead = np.zeros(n)
    bars = int(np.ceil(seconds / BAR))

    for b in range(bars):
        t0 = b * BAR
        root, notes = CHORDS[(b // 2) % 4]
        section = b  # arrangement by bar index
        # --- pad: detuned saws, 2 bars per chord, re-triggered each 2 bars
        if b % 2 == 0:
            ln = int(2 * BAR * SR)
            sig = np.zeros(ln)
            for m in notes + [notes[0] + 12]:
                for det in (-0.12, 0.0, 0.11):
                    sig += saw(midi(m + det), ln, rng.random())
            sig = lp(sig, 1400 if section >= 8 else 900) * env_adsr(ln, 0.6, 0.5, 0.8, 0.8) * 0.05
            add(pad, t0, sig)
        # --- bass: eighth notes from bar 4
        if b >= 4:
            for k in range(8):
                ln = int(BEAT / 2 * SR)
                f = midi(root - 12 + (12 if k in (3, 7) else 0))
                sig = (saw(f, ln) * 0.6 + square(f, ln) * 0.4)
                sig = lp(sig, 500) * env_adsr(ln, 0.005, 0.12, 0.5, 0.04) * 0.32
                add(bass, t0 + k * BEAT / 2, sig)
        # --- arp: 16ths from bar 8
        if b >= 8:
            seq = [notes[0], notes[1], notes[2], notes[0] + 12, notes[2], notes[1], notes[0] + 12, notes[2] + 12]
            for k in range(16):
                ln = int(BEAT / 4 * SR * 0.95)
                f = midi(seq[k % 8] + 12)
                sig = square(f, ln, 0.3) * env_adsr(ln, 0.002, 0.08, 0.15, 0.03)
                add(arp, t0 + k * BEAT / 4, lp(sig, 3200) * 0.06)
        # --- simple lead melody every other 8-bar block
        if b >= 16 and (b // 8) % 2 == 0:
            motif = [(0, 2, notes[2] + 12), (2, 1, notes[1] + 12), (3, 1, notes[0] + 12)]
            for beat, dur, m in motif:
                ln = int(dur * BEAT * SR)
                t = np.arange(ln) / SR
                vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * t)
                ph = np.cumsum(midi(m) * vib) / SR
                sig = (2 * (ph % 1.0) - 1) * 0.5 + np.sin(2 * np.pi * ph) * 0.5
                add(lead, t0 + beat * BEAT, lp(sig, 2500) * env_adsr(ln, 0.03, 0.2, 0.6, 0.15) * 0.07)
        # --- drums
        if b >= 4:
            for beat in range(4):
                tb = t0 + beat * BEAT
                # kick on every beat (four on the floor) from bar 8, else 1 and 3
                if b >= 8 or beat in (0, 2):
                    ln = int(0.35 * SR)
                    t = np.arange(ln) / SR
                    f = 45 + 110 * np.exp(-t * 28)
                    k = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)
                    add(drums, tb, k * 0.55)
                # snare on 2 and 4
                if beat in (1, 3) and b >= 6:
                    ln = int(0.25 * SR)
                    t = np.arange(ln) / SR
                    nz = hp(rng.standard_normal(ln), 1500) * np.exp(-t * 18)
                    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 25)
                    add(drums, tb, (nz * 0.22 + tone * 0.2))
                # hats on 8ths
                for h in range(2):
                    ln = int(0.06 * SR)
                    t = np.arange(ln) / SR
                    nz = hp(rng.standard_normal(ln), 7000) * np.exp(-t * 60)
                    add(drums, tb + h * BEAT / 2, nz * (0.025 if h == 0 else 0.04))

    # sidechain pump on pad + bass from the kick grid
    t = np.arange(n) / SR
    phase = (t % BEAT) / BEAT
    pump = 0.55 + 0.45 * np.minimum(1, phase / 0.45)
    pump[t < 8 * BAR] = 1.0  # no pumping before the beat drops
    pad *= pump
    # stereo: delay on arp, slight widening on pad
    d = int(BEAT * 0.75 * SR)
    arp_d = np.zeros(n)
    arp_d[d:] = arp[:-d] * 0.45
    left = pad * 1.0 + bass + drums + arp + arp_d * 0.3 + lead
    right = np.roll(pad, 300) + bass + drums + arp * 0.7 + arp_d + lead
    mix = np.stack([left, right], axis=1)
    # fades
    fi, fo = int(3 * SR), int(6 * SR)
    mix[:fi] *= np.linspace(0, 1, fi)[:, None]
    mix[-fo:] *= np.linspace(1, 0, fo)[:, None]
    mix = np.tanh(mix * 1.6) / np.tanh(1.6)
    mix /= np.max(np.abs(mix)) * 1.12
    return mix


if __name__ == '__main__':
    secs = float(sys.argv[1])
    out = sys.argv[2]
    wavfile.write(out, SR, (render(secs) * 32767).astype(np.int16))
    print('wrote', out)
