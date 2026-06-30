// Post-install note: point consumers at the bundled agent skill. Only prints when
// installed as a dependency (not during this package's own dev install / CI), and
// never fails the install.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

try {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const initCwd = process.env.INIT_CWD;

  // INIT_CWD is the directory the user ran `npm install` from. When that's our own
  // repo root it's a dev install — stay quiet. Otherwise we're a dependency.
  if (initCwd && resolve(initCwd) !== pkgRoot) {
    const skillDir = resolve(pkgRoot, "skills/conversation-proxy");
    console.log(
      [
        "",
        "conversation-proxy: a CLI skill for AI agents is bundled with this package:",
        `  ${resolve(skillDir, "SKILL.md")}`,
        "",
        "To make it discoverable by Claude Code, link it into your project's skills dir:",
        `  mkdir -p .claude/skills && ln -s "${skillDir}" .claude/skills/conversation-proxy`,
        "",
      ].join("\n"),
    );
  }
} catch {
  // never let a cosmetic note break an install
}
