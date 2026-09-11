#!/usr/bin/env bash
set -euo pipefail

: "${FEATURE_BRANCH:?must be set (configure it as a repo Actions Variable)}"
: "${SYNC_BRANCH:?must be set (configure it as a repo Actions Variable)}"
: "${UPSTREAM_REPO:?must be set, e.g. MoonshotAI/kimi-code}"
: "${UPSTREAM_BRANCH:?must be set, e.g. main}"
UPSTREAM_URL="https://github.com/${UPSTREAM_REPO}.git"

fail() {
  echo "::error::$*"
  exit 1
}

echo "::group::Setup"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$UPSTREAM_URL"
else
  git remote add upstream "$UPSTREAM_URL"
fi
git fetch upstream "$UPSTREAM_BRANCH"
git fetch origin
echo "::endgroup::"

UPSTREAM_REF="upstream/${UPSTREAM_BRANCH}"
UPSTREAM_SHA="$(git rev-parse --short "$UPSTREAM_REF")"

git fetch origin "$FEATURE_BRANCH"

# Reuse the sync branch only while its PR is still open; otherwise start fresh
# from the feature branch.
open_pr_number=""
if git show-ref --verify --quiet "refs/remotes/origin/${SYNC_BRANCH}"; then
  open_pr_number="$(gh pr list --state open --head "$SYNC_BRANCH" --base "$FEATURE_BRANCH" --json number --jq '.[0].number // empty')"
fi

if [ -n "$open_pr_number" ]; then
  echo "Reusing existing sync branch ${SYNC_BRANCH} (open PR #${open_pr_number})"
  git checkout -B "$SYNC_BRANCH" "origin/${SYNC_BRANCH}"
else
  echo "Starting fresh sync branch ${SYNC_BRANCH} from origin/${FEATURE_BRANCH}"
  git checkout -B "$SYNC_BRANCH" "origin/${FEATURE_BRANCH}"
fi

if git merge-base --is-ancestor "$UPSTREAM_REF" HEAD; then
  echo "Already up to date with ${UPSTREAM_REF}; nothing to do."
  exit 0
fi

OLD_HEAD="$(git rev-parse HEAD)"
INCOMING_COMMITS="$(git log --oneline "${OLD_HEAD}..${UPSTREAM_REF}")"
CONFLICTED=0
CONFLICT_FILES=""

echo "::group::Merge ${UPSTREAM_REF} into ${SYNC_BRANCH}"
if git merge --no-edit "$UPSTREAM_REF"; then
  echo "Clean merge."
else
  CONFLICTED=1
  CONFLICT_FILES="$(git diff --name-only --diff-filter=U)"
  echo "::warning::Merge conflicts in:"
  echo "$CONFLICT_FILES"
fi
echo "::endgroup::"

if [ "$CONFLICTED" -eq 1 ]; then
  echo "::group::Resolving conflicts with kimi CLI"
  PROMPT_FILE="$(mktemp)"
  cat > "$PROMPT_FILE" <<EOF
This repository is in the middle of a git merge with unresolved conflicts.

Context: this is a fork of ${UPSTREAM_REPO}. The current branch ${SYNC_BRANCH} is a sync branch
based on the fork feature branch ${FEATURE_BRANCH}, and it is merging upstream ${UPSTREAM_BRANCH}.
The feature branch adds a hook permission-decisions feature; upstream keeps evolving.

Task:
1. Run \`git status\` and \`git diff --name-only --diff-filter=U\` to list the conflicted files.
2. Resolve every conflict. Preserve the feature branch behavior: where upstream refactored code
   that the feature touches, adapt the feature changes onto the new upstream structure/APIs
   instead of reverting upstream changes. Where both sides added code, keep both.
3. Stage each resolved file with \`git add <file>\`.
4. Verify your resolution compiles: this is a pnpm monorepo; run \`pnpm install --frozen-lockfile\`
   if node_modules is missing, then run the typecheck or build for the affected packages only
   (for example \`pnpm --filter <package> run build\`). Do not run the full test suite.
5. Do NOT create any commit. Do NOT run git merge --continue. Do NOT push. Leave the working
   tree with all conflicts resolved and staged, merge state intact.

Finally report: each conflicted file, how you resolved it, and the verification results.
EOF
  kimi --auto -p "$(cat "$PROMPT_FILE")" || fail "kimi CLI exited with an error while resolving conflicts"
  rm -f "$PROMPT_FILE"
  echo "::endgroup::"

  remaining="$(git diff --name-only --diff-filter=U)"
  [ -z "$remaining" ] || fail "Unresolved conflict paths remain: ${remaining}"

  markers_left=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if grep -qE '^(<<<<<<<|>>>>>>>|=======$)' "$f"; then
      echo "::error::Conflict markers still present in $f"
      markers_left=1
    fi
  done <<< "$CONFLICT_FILES"
  [ "$markers_left" -eq 0 ] || fail "Conflict markers left in resolved files"

  if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    git add -A
    git commit --no-edit
  fi
fi

echo "::group::Push ${SYNC_BRANCH}"
if git show-ref --verify --quiet "refs/remotes/origin/${SYNC_BRANCH}"; then
  git push --force-with-lease origin "$SYNC_BRANCH"
else
  git push -u origin "$SYNC_BRANCH"
fi
echo "::endgroup::"

PR_BODY_FILE="$(mktemp)"
{
  echo "Automated daily sync of upstream \`${UPSTREAM_REPO}#${UPSTREAM_BRANCH}\` (${UPSTREAM_SHA}) into \`${FEATURE_BRANCH}\` via \`${SYNC_BRANCH}\`."
  echo
  if [ "$CONFLICTED" -eq 1 ]; then
    echo "**Merge conflicts were resolved automatically by kimi CLI.** Review carefully before merging."
    echo
    echo "Conflicted files:"
    echo '```'
    echo "$CONFLICT_FILES"
    echo '```'
    echo
  else
    echo "Merged cleanly, no conflicts."
    echo
  fi
  echo "Upstream commits brought in:"
  echo '```'
  echo "$INCOMING_COMMITS"
  echo '```'
} > "$PR_BODY_FILE"

if [ -n "$open_pr_number" ]; then
  echo "Updating existing PR #${open_pr_number}"
  gh pr comment "$open_pr_number" --body-file "$PR_BODY_FILE"
else
  echo "::group::Create PR"
  gh pr create \
    --base "$FEATURE_BRANCH" \
    --head "$SYNC_BRANCH" \
    --title "chore: merge upstream ${UPSTREAM_BRANCH} into ${FEATURE_BRANCH} ($(date -u +%Y-%m-%d))" \
    --body-file "$PR_BODY_FILE"
  echo "::endgroup::"
fi

echo "Done."
