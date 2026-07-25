# Benchmark notes

*Claude Opus 5 · built in one session, no human guidance beyond "pick one of three and build it."*

Usage instructions live in [README.md](README.md). This file answers the questions asked.

---

## What made you decide to build what you built?

I picked the **music visualiser** over the game and the car configurator, for three reasons.

**It has the highest ceiling per unit of risk.** A car configurator's quality is dominated by
the 3D model, and with no assets available I'd have been hand-authoring a procedural car —
where the difference between "convincing" and "sad polygon blob" is enormous and mostly
outside my control. A game's quality is dominated by *feel*, which I can't evaluate: I can't
play it, so I'd be shipping combat balance and jump arcs blind. A visualiser's quality is
dominated by signal processing and shader work — two things I can reason about precisely,
and two things where being careful genuinely shows.

**It's the option where the invisible work is the differentiator.** Almost every browser
visualiser wires `getByteFrequencyData` straight into bar heights and calls it done. That
looks like a spectrum analyser, not like something listening to music. The interesting
problem is upstream: onset detection that ignores sustained energy, tempo estimation that
survives off-beat percussion, a beat clock that keeps time through a breakdown, colour that
tracks the actual key. That work is where a considered build separates from a quick one, and
it's the part I could get genuinely right.

**It had a cold-start problem worth solving.** A visualiser with no audio is a black
rectangle, and I couldn't ship any audio assets. Rather than hope you'd have a file handy, I
wrote a generative track — a real arrangement in WebAudio with a lookahead scheduler, an
eight-section form, a convolution reverb built from a synthesised impulse response. That made
the project self-demonstrating, and it also gave me a *known* signal to develop the DSP
against: I know the demo is 122 BPM in A minor, so when the tempo readout says 122 and the key
readout says A, the analysis is working. It became my test fixture as much as my demo.

I also just think it's the most interesting of the three. Sound and light are the same problem
wearing different clothes, and the fun is in the mapping.

## What part took you the longest?

**Tuning, by a wide margin — specifically the raymarched tunnel.** Writing the code was the
fast part; deciding it looked right was slow.

The first full render was a disaster: every scene was a blown-out white smear. Additive
blending plus bloom plus a tone-map curve is a compounding chain, and I had been picking
per-scene constants in isolation without an intuition for where they'd land after post. So I
built a headless-Chrome harness ([`scripts/smoke.mjs`](scripts/smoke.mjs)) that boots the app,
visits every scene and palette, screenshots each one, and fails on console errors, a blank
canvas, or more than 12% of pixels clipping white. That turned "does this look good" into a
loop I could actually run, and gave me images to look at instead of guesses.

The tunnel then took four full iterations. It kept rendering as a pretty vortex rather than a
corridor, and each attempt fixed one cause and revealed the next:

1. The axis wander was larger than the tunnel radius, so the camera kept ending up *inside the
   wall*.
2. The flutes carried a `z` term, which turned longitudinal grooves into a spiral pinwheel.
3. Every step contributed equal weight regardless of how far it travelled, so grazing rays
   piled up hundreds of samples and washed the frame edges out. Weighting each sample by its
   step length turned the loop into an actual integral along the ray.
4. The real culprit: the march never stopped at the wall. It kept going and accumulated every
   ring the ray passed *behind* it. Breaking on the first `d < 0` was the one-line change that
   finally made it a corridor.

Only #4 was a bug in the ordinary sense. The other three were the slower kind of problem — the
code did exactly what I wrote, and what I wrote was the wrong idea.

Second place goes to the beat clock. Making onset detection fire on the right frames is
straightforward; making a tempo estimate that doesn't flip between 60 and 120 BPM required
harmonic folding into a decaying histogram, and making the beat phase *feel* locked required a
PLL that nudges rather than snaps — a hard reset on every onset is visibly jittery, and it
falls apart the moment the detector misses one.

## How was it deciding everything on your own?

Freeing on the shape of the thing, and harder than expected on the small stuff.

The big decisions were easy and I made them fast: visualiser over game; four distinct scenes
rather than eight variations on one; hand-write the post chain instead of pulling in
`EffectComposer`; no UI framework. Those all follow from one principle — the demo should show
depth in the places that matter and spend nothing anywhere else.

What I found genuinely hard was *taste calibration without feedback*. How bright is too
bright? Is the tunnel supposed to read as a corridor or is a vortex fine? Is grain at 0.05
tasteful or grubby? Those questions have no correct answer derivable from first principles;
normally you glance at a person's face. My substitute was to make the loop mechanical: pick a
number, render, look, adjust. Slower than a collaborator, but it converges, and it kept me
honest — I caught the overexposure because I looked at a screenshot, not because I reasoned
about it.

The other thing I noticed: with nobody to ask, I defaulted to *building the thing that answers
the question*. Unsure whether the visuals were dead on the landing screen? Ship an idle wash
and look. Unsure whether the tempo detector worked? Put the BPM on screen where a wrong answer
is embarrassing. Several features in this project exist because they were the cheapest way to
find out whether something else was right, and they earned their place afterwards.

The one place I'd have liked a human: I can't hear the demo track. I can reason about the
synthesis graph, verify the scheduling maths, confirm the arrangement is harmonically sensible
— but whether "Parallax" is actually *pleasant* is the single claim in this project I can't
verify myself.

## What would you give yourself, 1–10?

**8.**

What earns it:

- The analysis layer is real work, not decoration. Median-threshold flux, a folded IOI tempo
  histogram, a phase-locked beat clock, circle-of-fifths chroma mapping. It locks onto 122 BPM
  and the right key within a couple of bars, and it behaves the same on a quiet recording as on
  a loud master because of the auto-gain stage.
- Four scenes that are genuinely different *readings* of the signal — a physical simulation, a
  volumetric render, a data visualisation, and an instrument panel — rather than four palettes
  on one idea.
- The infrastructure is honest. Adaptive resolution sheds pixels rather than features. The post
  chain tone-maps exactly once. The scene contract is small enough that a fifth scene is about
  150 lines. There's an automated visual test, and it catches real regressions.
- It runs from `npm start` with zero assets and zero configuration, and the interface looks
  designed rather than defaulted.

What holds it back:

- **I can't hear it.** The demo track is the least verified thing here.
- **The tunnel is the weakest scene.** It's good now, but it took four passes to get there and
  it's still the one where the audio mapping is least legible — you can *feel* the music in it,
  but you can't *read* it the way you can in Terrain or Oscillo.
- **No real-device performance data.** Every frame-rate number I have comes from a software
  rasteriser. The adaptive-resolution controller is correct in principle and completely
  untested against an actual GPU under load.
- **Untested on touch.** The layout is responsive and the controls are click-driven, so it
  should work, but "should" is doing real work in that sentence.
- **No unit tests on the DSP.** The smoke test verifies the pipeline end to end and the BPM
  readout is a strong live signal, but the tempo tracker deserves a test with synthetic click
  tracks at known tempi, and doesn't have one.

An honest 9 would need the demo track auditioned by someone with ears, a session on real
hardware with a frame profiler, and tests for the tempo tracker. Those are all things I could
not do from here, which is exactly why I'm not claiming them.

## Other notes

A few decisions worth calling out, since they're the sort of thing that's invisible unless
someone points at them:

- **Particles are assigned frequency bands, not colours.** Each of the ~100k particles owns one
  band and orbits on that band's ring, so the galaxy's structure *is* the spectrum rather than
  being tinted by it. When the bass hits, a specific ring expands.
- **Hue follows the circle of fifths, not the chromatic scale.** Chroma is averaged as vectors
  positioned by fifths, so a move from C to G shifts the colour slightly and a move from C to
  F♯ shifts it a lot — which is how those transitions actually sound.
- **`max(src, prev·persistence)` for trails, not `src + prev·p`.** The additive form is a
  geometric series that blows out on any sustained bright pixel. The max form gives clean
  phosphor decay with no runaway, which is what makes the Oscillo scene work.
- **The scene transition cuts through black.** The old scene renders for the first 45% of the
  transition, the new one after, with exposure dipping through zero at the crossover. Much
  cheaper than crossfading two live scenes, and it reads as an intentional edit rather than a
  dissolve.
- **The glow and trails sliders scale each scene's own preferences** rather than overriding
  them, so a scene tuned for heavy persistence stays heavier than one that isn't, at every
  slider position.
- **The microphone never reaches the speakers.** The analyser hangs off the graph as a leaf
  node so live input can be measured without being played back. I had this wrong in the first
  pass — the analyser was inline before the output — and caught it on review rather than by
  deafening anyone.
- **The idle wash only ever raises values.** When nothing is playing, a slow synthetic swell
  fades in so the scenes breathe; it can't mask real audio because it's a `max`, and the BPM
  and key readouts still honestly show `—`.

Everything in this repository — every sound, every pixel, every gradient — is generated at
runtime. There is not one asset file.
