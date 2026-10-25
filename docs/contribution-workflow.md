# Test Citadel through a contribution

Use a small real issue with a measurable result. The current Work/Docs fixes in
Citadel are the first local contribution candidate: a retry must consume budget,
a failed plan publication must leave no partial queue, and existing Markdown
must link without opening the Docs screen first. Regression suites cover those
cases. These fixes ship in Citadel v0.44.0; an external contribution remains a
separate follow-up.

For another open source repository:

1. Choose an issue and read its contribution instructions and license. Clone a
   fork into `PROJECTS_DIR` using Projects, or clone manually and import the
   discovered folder. Discovery itself runs no repository code.
2. Create a branch in the project terminal. Open the same folder using the
   project's VS Code action; use an SSH alias when it lives on another machine.
3. Reproduce the issue and record exact acceptance criteria in Work. Start with
   one small task; keep review human and use the existing daily attempt budget.
4. Make the change, run that repository's checks and inspect the Git diff. Update
   its docs only when behaviour changes. Record evidence and relevant Markdown
   paths in the task's handoff; accept the result after checking the criteria.
5. Retain a confirmed Learning entry only if it will help future work. A transient
   provider outage is evidence, not a demonstrated defect in the repository.
6. Prepare the commit/PR description with the trigger, changed behaviour and
   checks. Have the operator review it before pushing or publishing.

Record friction after the exercise: steps needing another tool, unclear task
states, useless memory entries, missing editor functionality and resource costs.
Use that evidence to decide whether a hosted editor or more automation is needed.
No external issue or repository has been chosen and no contribution has been
published as part of the local validation.
