# Implement, review, and measure

Record the baseline, the measured acceptance target, and the benchmark host, such as `machine: "perf"` when configured. Ask the user for any of these that the goal leaves unsettled. Confirm the host has the required memory, disk, and cores. Use its exclusive resource claim for measurements when configured.

Assign an implementer to produce a candidate commit. Once ready, have a reviewer inspect that commit and a measurer compare it with the baseline on the named machine. Run the tasks in parallel. Require both reports to name the exact candidate and have the measurer record the command, workload, and results. If the target is missed or a review finding needs a fix, add a work item and repeat the applicable checks on the revised commit. End with the reviewed commit, the measurements, and any unresolved work.
