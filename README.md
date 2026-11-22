# Lattice Game Sim

An interactive simulator of evolutionary games on a lattice, in the browser:

**https://petarsteinberg.github.io/lattice-game-sim/**

Every site of an L × L lattice (wrapping at the edges) holds a memory-one strategy, a vector of
probabilities that starts out completely random. Each generation, every player plays an iterated
game against each neighbour within the chosen radius, then picks one neighbour at random and copies
its strategy only if that neighbour scored more. Each pair's game can continue from one generation
to the next (by default, with copying after every round) or start afresh every generation.

- **Games:** the Prisoner's Dilemma (any T, R, P, S) and matching pennies.
- **Settings:** lattice size (up to 400 × 400), neighbour radius, rounds per generation, continue or
  repeat the game, play against yourself, exact expected or sampled game outcomes, and the random
  seed. The same seed and settings always give the same run.
- **Charts:** the strategy mix over generations, with the share of C moves and of mutual
  cooperation (CC), and the strategy vector's components.
- **Experiment designer** (`designer.html`, linked from the simulator): set up a sweep of
  settings and seeds, run it in the browser on several cores, watch the mean strategy mix and a
  per-setting summary build up, and download every run file as a zip, plus a summary CSV and the
  chart. It also offers a Fermi temperature K and mutators. The run files are the same as the
  command-line runner's in the development repository.

The simulator is two files, `index.html` and `model.js`, with no build step: download them and open
`index.html` to run it offline. The experiment designer also needs `designer.html`,
`designer-worker.js` and `runner.js`, and must be served over http (for example
`python -m http.server` in a folder holding all five files), because browsers do not start
workers from local files.

This repository only hosts the page. The simulator is developed, tested (including bit-for-bit
golden runs) and used for batch experiments in a separate repository, and copied here from there;
each commit names the version it came from.
