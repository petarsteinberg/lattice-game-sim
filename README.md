# Lattice Game Sim

An interactive simulator of evolutionary games on a lattice, in the browser:

**https://petarsteinberg.github.io/lattice-game-sim/**

Every site of an L × L lattice (wrapping at the edges) holds a memory-one strategy, a vector of
probabilities that starts out completely random. Each generation, every player plays an iterated
game against each neighbour within the chosen radius, then compares its total payoff with a random
neighbour's and copies that neighbour's strategy with the Fermi probability
1 / (1 + exp(−Δ/K)). Each pair's game can continue from one generation to the next (by default,
with copying after every round) or start afresh every generation. Optional mutators sit at random
sites and nudge their own vectors; keen ones keep a change only when it pays.

- **Games:** the Prisoner's Dilemma (any T, R, P, S) and matching pennies.
- **Settings:** lattice size (up to 400 × 400), neighbour radius, rounds per generation, continue or
  repeat the game, play against yourself, exact expected or sampled game outcomes, Fermi
  temperature K, number of mutators, their window W, step size σ and whether they are keen, and
  the random seed. The same seed and settings always give the same run.
- **Charts:** strategy mix, cooperation (or payoff spread), mean payoff (or exploitability) with
  well-mixed and mean-vs-mean reference lines, and the strategy vector's components.
- **Run files:** export a run with every setting and edit you made, and load one to replay it
  exactly.
- **Experiment designer** (`designer.html`, linked from the simulator): set up a sweep of
  settings and seeds, run it in the browser on several cores, watch the mean strategy mix and a
  per-setting summary build up, and download every run file as a zip, plus a summary CSV and the
  chart. The run files are the same as the command-line runner's in the development repository.

The simulator is two files, `index.html` and `model.js`, with no build step: download them and open
`index.html` to run it offline. The experiment designer also needs `designer.html`,
`designer-worker.js` and `runner.js`, and must be served over http (for example
`python -m http.server` in a folder holding all five files), because browsers do not start
workers from local files.

This repository only hosts the page. The simulator is developed, tested (including bit-for-bit
golden runs) and used for batch experiments in a separate repository, and copied here from there;
each commit names the version it came from.
