---
description: Design, plan, and implement a new feature or change
agent: build
---

Please plan the following new feature or change that has been requested by the user.

-----
$ARGUMENTS
-----

## Steps

Each step includes at least one "Gate" that proscribes user interaction or a checklist of requirements to satisfy before proceeding to the next step.


### Investigate
Research the code base and identify the surface area for this change.
Identify documentation, unit test coverage and gaps, QA coverage and gaps, and footguns associated with that surface area.
Identify ambiguity in the request; consider likely implementations and what sorts of details are likely to trip you up if not resolved before planning.

#### Gate 1
If there are any ambiguities or conflicts, ask the user for clarification on the intent, before proceeding.
Update the session's title to reflect the change you are working on, as briefly as possible.
Include your thatch chat name in the session title.
Continue to the next step once the user has satisfied all of your concerns and resolved any ambiguities you identified.


### Plan
Think through the different implementation options that makes sense for this change.
Select the implementation that has the best balance of the following criteria:
- Simplicity and ease of understanding
- Maintainability
- Testability
- Reliability and minimal side effects
- User experience
- Agent experience, especially for the interface visible to the agent; optimize for least confusion or likelihood of misinterpretation
- Ease of debugging
Often, considering a change in terms of testability can identify problems with a design.
Similarly, if a design requires ambiguity and hope in order to implement useful QA use cases, the design may have gaps or poor UX.

#### Gate 1
Once you are satisfied with your plan, create a new worktree.
Save your plan in `./docs/plans` and commit your plan within the new branch.

#### Gate 2
Perform as many rounds of refinement on the plan as continue to produce useful, meaningful results; commit your changes after each round.

#### Gate 3
Present your plan to the user.
Keep your presentation brief, focusing on the most important, high level details.
Continue working with the user until all of their concerns, questions, and recommendations have been squared in the plan.
If this results in a significant change in direction for the implementation, GOTO Gate 2.
Continue to the next step once the user greenlights your plan.


### Implement
In your worktree, implement the changes according to the plan you designed.
When possible and unlikely to cause conflicts, farm facets of the work out to subagents.
Ensure adequate test coverage and QA use cases where appropriate.
Ensure that documentation is up to date, including user docs for all user-facing features, and dev docs for all features that involve significant infrastructure (for example, a single new skill or command does not require a dev doc).
Remember that we do the dishes as we go! Make a mental note and present these to the user during the "Merge" step's gates.

#### Gate 1
`mise check` is entirely green.
There is no stray output to stdout or stderr that is not captured by the tests that trigger them.
All tests are guaranteed not to make use of or overwrite the user's personal config, which resides on the same machine.

#### Gate 2
Perform as many rounds of structured review, using subagents, as continue to produce meaningful findings.
After each round, ensure that `mise check` and the other requirements from Gate 1 continue to hold.

#### Gate 3
If the change involves existing or new QA use cases, those continue to pass.


### Merge
Determine if there is a "coordinator" session with which you must coordinate the merge of your changes.

### Gate 1
If the changes represent a significant change in user-facing or agent-facing behavior, or if the changes involve multiple subsystems and therefore include the risk of side effects, perform a full manual QA step.

### Gate 2
The following gates are grouped by whether you are working with a coordinator session or directly with the user.

#### Coordinator Session
Contact the coordinator session to inform it of the change you have implemented, the worktree in which it resides, and that you believe it is complete.
Include a high level explanation of the change and its implementation.
Summarize the steps you have taken, the gates cleared, and the current status of the project.
Request its help in coordinating merging your changes to main.
Ask whether it will be tracking CI, or whether you should.
Ask whether it intends to notify the user of the implementation's completion and/or CI state once merged and pushed, or whether you should.

#### User
Notify the user using zarvox to inform them that the implementation is complete.
Summarize the change and the current state, QA and testing results, and the number of lines changes.
Merge to main once the user has green-lit you to do so.
Push to origin once the user has green-lit you to do so.
Once on origin, initialize a watcher for CI to ensure that the change lands cleanly.
Notify the user using zarvox when CI is complete and whether it succeeded or failed.
On failure, iterate until CI is green.

### Gate 3
Provide a final response that summarizes the work completed, with broad strokes describing the feature, the major pivots, as well as unit test, QA, and CI status.
