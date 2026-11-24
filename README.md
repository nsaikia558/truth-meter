# Truth Meter (prototype)

An experimental browser app that uses the camera and microphone to measure stress signals while someone answers a list of questions: heart rate from the face camera (remote PPG), blinks, eye movement, face tension, head movement, answer delay and voice timing.

Truthful **baseline** answers set the person's normal stress level. Each **test** answer is marked Truth (below the threshold) or Lie (above it), with a confidence score.

**This is not a real lie detector.** It measures stress and effort, which nerves, lighting and movement also change. Use it only with people who agree, and never to make decisions about anyone.

All processing happens in the browser. No video or audio is recorded or uploaded.

Live: https://nsaikia558.github.io/truth-meter/ · Simulation mode (no camera): add `?sim=1`
