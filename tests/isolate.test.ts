import { describe, expect, it } from "vitest";
import {
  buildIsolateCommand,
  diagnose,
  regexEscape,
  shellEscapeDoubleQuoted,
} from "../src/core/isolate.js";

/**
 * Unit tests for the PURE parts of isolation diagnosis — the template
 * substitution / escaping (the SPEC §4 sharp edge) and the diagnosis
 * classification. The I/O `isolate()` loop is exercised live against the fixture
 * (see PROGRESS verification), not here.
 */

describe("diagnose", () => {
  it("all-pass alone → order-dependent (external cause)", () => {
    expect(diagnose(10, 0)).toBe("order-dependent");
  });

  it("any fail alone → internally-nondeterministic (fails on its own)", () => {
    expect(diagnose(7, 3)).toBe("internally-nondeterministic");
    expect(diagnose(0, 10)).toBe("internally-nondeterministic"); // never passed alone
  });

  it("no definitive outcome → unknown", () => {
    expect(diagnose(0, 0)).toBe("unknown");
  });
});

describe("regexEscape", () => {
  it("escapes regex metacharacters so a literal name matches literally", () => {
    // The fixture's real failure mode: unescaped parens are read as a group.
    expect(regexEscape("specimen A — coin flip (fails ~30% at random)")).toBe(
      "specimen A — coin flip \\(fails ~30% at random\\)",
    );
  });

  it("escapes the full metacharacter set", () => {
    expect(regexEscape("a.b*c+d?[e]{f}^g$h|i(j)\\k")).toBe(
      "a\\.b\\*c\\+d\\?\\[e\\]\\{f\\}\\^g\\$h\\|i\\(j\\)\\\\k",
    );
  });
});

describe("shellEscapeDoubleQuoted", () => {
  it("POSIX: backslash-escapes the double-quote-special chars", () => {
    expect(shellEscapeDoubleQuoted('a"b$c`d\\e', "linux")).toBe('a\\"b\\$c\\`d\\\\e');
  });

  it("Windows: doubles embedded double quotes, leaves backslashes alone", () => {
    // cmd.exe treats backslashes literally, so a regex-escaped `\(` must survive.
    expect(shellEscapeDoubleQuoted('a"b\\(c', "win32")).toBe('a""b\\(c');
  });
});

describe("buildIsolateCommand", () => {
  const target = {
    file: "tests/order.test.ts",
    name: "victim B — assumes a clean resource (fails after the polluter)",
  };

  it("substitutes {file} and a regex+shell-safe {testNamePattern} (POSIX)", () => {
    const cmd = buildIsolateCommand(
      'npx vitest run {file} -t "{testNamePattern}"',
      target,
      "linux",
    );
    // Parens are regex-escaped (`\(`) then the backslash is shell-escaped (`\\(`),
    // so the shell hands the runner a literal `\(` → matches the real paren.
    expect(cmd).toBe(
      'npx vitest run tests/order.test.ts -t "victim B — assumes a clean resource \\\\(fails after the polluter\\\\)"',
    );
  });

  it("{testName} is the raw name (shell-escaped only), not regex-escaped", () => {
    const cmd = buildIsolateCommand('run -k "{testName}"', target, "linux");
    expect(cmd).toBe('run -k "victim B — assumes a clean resource (fails after the polluter)"');
  });

  it("replaces {testNamePattern} without corrupting the {testName} substring token", () => {
    // {testName} is a substring of {testNamePattern}; a naive ordering would
    // mangle the longer token. Both must resolve to their own values.
    const cmd = buildIsolateCommand("{testNamePattern} :: {testName}", target, "linux");
    expect(cmd).toBe(
      "victim B — assumes a clean resource \\\\(fails after the polluter\\\\) :: victim B — assumes a clean resource (fails after the polluter)",
    );
  });

  it("substitutes every occurrence of a placeholder", () => {
    const cmd = buildIsolateCommand("{file} {file}", target, "linux");
    expect(cmd).toBe("tests/order.test.ts tests/order.test.ts");
  });

  it("Windows: regex escaping survives cmd.exe as a SINGLE backslash", () => {
    // cmd.exe treats `\` literally, so (unlike POSIX sh) it must NOT be doubled —
    // the runner has to receive `\(` to match the literal paren.
    const cmd = buildIsolateCommand(
      'npx vitest run {file} -t "{testNamePattern}"',
      target,
      "win32",
    );
    expect(cmd).toBe(
      'npx vitest run tests/order.test.ts -t "victim B — assumes a clean resource \\(fails after the polluter\\)"',
    );
  });

  it("{file} is forward-slashed, so a Windows path survives the shell", () => {
    const cmd = buildIsolateCommand("{file}", { ...target, file: "tests\\order.test.ts" }, "win32");
    expect(cmd).toBe("tests/order.test.ts");
  });

  it("a template with no placeholders is passed through unchanged", () => {
    expect(buildIsolateCommand("npm run test:one", target, "linux")).toBe("npm run test:one");
  });
});
