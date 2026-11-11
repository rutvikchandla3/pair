# Workspaces

A workspace lets one thread change several repositories at once, such as an API and the web app
that calls it. It is a project made of other projects on the same machine. Each thread in it gets
its own folder with a fresh checkout of every repository, so the agent can read and edit across
them and you review the result in one place.

## Create a workspace

A workspace needs 2 to 8 repositories. Each one must already be a project on that machine, its
folder must be the top folder of a git repository, and it can't be a workspace itself.

- **In the desktop or web app,** run **New workspace** from the command palette, name it, and
  pick its repositories.
- **On your phone,** choose **New workspace** on the Add project screen.
- **From a shell,** pass `--root` once per repository with a project id or folder, and a title:

  ```sh
  npx t3 project add --title "Acme stack" --root ~/code/api --root ~/code/web=frontend
  ```

- **Agents** create one with `t3_project_create` and a list of `roots`, through
  [Pair's MCP server](./outside-agents.md).

Each repository gets a folder name inside the thread's folder. By default it is the name of the
project's folder, with spaces and other unusual characters replaced by `-`. Change it when you
create the workspace or in its settings, or give one with `<project>=<name>` on the command line.
Names may use letters, digits, `.`, `_` and `-`, and two repositories can't share one.

To change the repositories later, choose the workspace in **Settings → Projects**. A change
applies to new threads only. Existing threads keep the repositories they started with.

Everyone on the server sees every workspace, as with projects.

## How threads in a workspace work

- Every thread starts in a new worktree. A workspace thread can't run in a project checkout or an
  existing worktree.
- The thread gets one folder in your [worktree location](./project-settings.md#worktree-location),
  with a worktree of each repository inside it, named by its folder name.
- All the repositories use the same branch name. Each one starts from its own default branch, not
  from a base branch you pick.
- When Pair names the branch, it renames it in every repository. If the new name is taken in any
  of them, none is renamed.
- Each repository's setup script runs in its own worktree. The workspace's own setup script, if
  you add one, runs in the thread's folder.
- The agent starts in the thread's folder, which is not a git repository. Pair writes an
  `AGENTS.md` and a `CLAUDE.md` there that list the repositories and tell the agent to run git
  inside each one.
- A repository's own agent setup, such as its skills or MCP servers, isn't loaded, because the
  agent doesn't start inside it.
- Each turn's changed files, the diff panel and reverting to an earlier turn cover every
  repository. Paths start with the repository's folder name, such as `frontend/src/app.ts`.
  A revert changes nothing if any repository is missing or has no checkpoint for that turn.

You can't delete a project while a workspace uses it. Remove it from the workspace first.

## Not supported yet

- Git controls and pull request actions for each repository. Commit, push and open pull requests
  from the agent or a terminal inside each repository.
- Automatic cleanup. Storage cleanup never removes a workspace thread's folder. When you delete
  the thread, Pair may offer to remove it; otherwise remove it by hand.
- Cloud. A workspace thread can't run in Cloud or move between your Mac and Pair Cloud, and a Pair
  Cloud server has no workspaces.
