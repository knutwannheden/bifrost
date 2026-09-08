/**
 * The pill's two halves answer two questions — can it land, is it green — and
 * each has to answer only its own. Run with `npm run check:pr-verdicts`.
 */
import { type GhPrFacts, verdictsFor } from '../src/main/pr-verdicts.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}

const pr = (over: Partial<GhPrFacts>): GhPrFacts => ({
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  ...over,
});

// moderneinc/moderne-cli#4490: 4 SUCCESS, 5 SKIPPED, REVIEW_REQUIRED, BLOCKED.
// Both halves used to read gray, which is also how a draft reads.
{
  const v = verdictsFor(
    pr({
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [
        { conclusion: 'SUCCESS' },
        { conclusion: 'SUCCESS' },
        { conclusion: 'SKIPPED' },
        { conclusion: 'SKIPPED' },
      ],
    }),
  );
  check(
    'a PR waiting only on review still reports its checks as passing',
    v.merge === 'awaiting-review' && v.ci === 'passing',
    `  got merge=${v.merge} ci=${v.ci}`,
  );
}

check(
  'a draft weighs no mergeability but still reports its checks',
  (() => {
    const v = verdictsFor(
      pr({ isDraft: true, mergeStateStatus: 'DRAFT', statusCheckRollup: [{ conclusion: 'FAILURE' }] }),
    );
    return v.merge === null && v.ci === 'failing';
  })(),
);

check('a merged PR stops reporting mergeability', verdictsFor(pr({ state: 'MERGED' })).merge === null);

check(
  'conflicts and requested changes both raise the alarm',
  verdictsFor(pr({ mergeStateStatus: 'DIRTY' })).merge === 'conflicts' &&
    verdictsFor(pr({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' })).merge === 'changes-requested',
);

check('a branch behind its base says so', verdictsFor(pr({ mergeStateStatus: 'BEHIND' })).merge === 'behind');

check('an approved, clean PR is mergeable', verdictsFor(pr({})).merge === 'mergeable');

check(
  'a run in flight outranks a failure that has already landed',
  verdictsFor(pr({ statusCheckRollup: [{ conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }] })).ci === 'running',
);

check(
  'a PR with no checks reports nothing rather than success',
  verdictsFor(pr({ statusCheckRollup: [] })).ci === null,
);

process.exit(failed === 0 ? 0 : 1);
