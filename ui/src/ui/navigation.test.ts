import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import {
  TAB_GROUPS,
  iconForTab,
  inferBasePathFromPathname,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  subtitleForTab,
  tabFromPath,
  titleForTab,
  type Tab,
} from "./navigation.ts";

/** All valid tab identifiers derived from TAB_GROUPS */
const ALL_TABS: Tab[] = TAB_GROUPS.flatMap((group) => group.tabs) as Tab[];

// The `titleForTab` / `subtitleForTab` assertions below are authored in
// English. In shells with `LANG=zh_CN.*`, the i18n manager auto-resolves to
// `zh-CN` and the assertions fail even though the translation layer is
// working correctly. Lock the locale to `en` for this test file so the
// documented contract is verified deterministically regardless of host
// environment.
beforeAll(async () => {
  await i18n.setLocale("en");
});

describe("iconForTab", () => {
  it("returns a non-empty string for every tab", () => {
    for (const tab of ALL_TABS) {
      const icon = iconForTab(tab);
      expect(icon).toBeTruthy();
      expect(typeof icon).toBe("string");
      expect(icon.length).toBeGreaterThan(0);
    }
  });

  it("returns stable icons for known tabs", () => {
    expect(iconForTab("chat")).toBe("messageSquare");
    expect(iconForTab("overview")).toBe("barChart");
    expect(iconForTab("channels")).toBe("link");
    expect(iconForTab("instances")).toBe("radio");
    expect(iconForTab("sessions")).toBe("fileText");
    expect(iconForTab("cron")).toBe("loader");
    expect(iconForTab("skills")).toBe("zap");
    expect(iconForTab("nodes")).toBe("monitor");
    expect(iconForTab("config")).toBe("settings");
    expect(iconForTab("debug")).toBe("bug");
    expect(iconForTab("logs")).toBe("scrollText");
    expect(iconForTab("remoteTerminal")).toBe("terminal");
    expect(iconForTab("videoStudio")).toBe("film");
  });

  it("returns a fallback icon for unknown tab", () => {
    // TypeScript won't allow this normally, but runtime could receive unexpected values
    const unknownTab = "unknown" as Tab;
    expect(iconForTab(unknownTab)).toBe("folder");
  });
});

describe("titleForTab", () => {
  it("returns a non-empty string for every tab", () => {
    for (const tab of ALL_TABS) {
      const title = titleForTab(tab);
      expect(title).toBeTruthy();
      expect(typeof title).toBe("string");
    }
  });

  it("returns expected titles", () => {
    expect(titleForTab("chat")).toBe("Chat");
    expect(titleForTab("overview")).toBe("Overview");
    expect(titleForTab("cron")).toBe("Cron Jobs");
  });
});

describe("subtitleForTab", () => {
  it("returns a string for every tab", () => {
    for (const tab of ALL_TABS) {
      const subtitle = subtitleForTab(tab);
      expect(typeof subtitle).toBe("string");
    }
  });

  it("returns descriptive subtitles", () => {
    expect(subtitleForTab("chat")).toContain("quick interventions");
    expect(subtitleForTab("config")).toContain("openclaw.json");
  });
});

describe("normalizeBasePath", () => {
  it("returns empty string for falsy input", () => {
    expect(normalizeBasePath("")).toBe("");
  });

  it("adds leading slash if missing", () => {
    expect(normalizeBasePath("ui")).toBe("/ui");
  });

  it("removes trailing slash", () => {
    expect(normalizeBasePath("/ui/")).toBe("/ui");
  });

  it("returns empty string for root path", () => {
    expect(normalizeBasePath("/")).toBe("");
  });

  it("handles nested paths", () => {
    expect(normalizeBasePath("/apps/openclaw")).toBe("/apps/openclaw");
  });
});

describe("normalizePath", () => {
  it("returns / for falsy input", () => {
    expect(normalizePath("")).toBe("/");
  });

  it("adds leading slash if missing", () => {
    expect(normalizePath("chat")).toBe("/chat");
  });

  it("removes trailing slash except for root", () => {
    expect(normalizePath("/chat/")).toBe("/chat");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("pathForTab", () => {
  it("returns correct path without base", () => {
    expect(pathForTab("chat")).toBe("/chat");
    expect(pathForTab("overview")).toBe("/overview");
    expect(pathForTab("remoteTerminal")).toBe("/yy-video/remote-servers/terminal");
    expect(pathForTab("videoStudio")).toBe("/video-studio");
  });

  it("prepends base path", () => {
    expect(pathForTab("chat", "/ui")).toBe("/ui/chat");
    expect(pathForTab("sessions", "/apps/openclaw")).toBe("/apps/openclaw/sessions");
    expect(pathForTab("remoteTerminal", "/ui")).toBe("/ui/yy-video/remote-servers/terminal");
    expect(pathForTab("videoStudio", "/ui")).toBe("/ui/video-studio");
  });
});

describe("tabFromPath", () => {
  it("returns tab for valid path", () => {
    expect(tabFromPath("/chat")).toBe("chat");
    expect(tabFromPath("/overview")).toBe("overview");
    expect(tabFromPath("/sessions")).toBe("sessions");
    expect(tabFromPath("/dreaming")).toBe("dreams");
    expect(tabFromPath("/dreams")).toBe("dreams");
    expect(tabFromPath("/yy-video/remote-servers/terminal")).toBe("remoteTerminal");
    expect(tabFromPath("/video-studio")).toBe("videoStudio");
  });

  it("returns chat for root path", () => {
    expect(tabFromPath("/")).toBe("chat");
  });

  it("handles base paths", () => {
    expect(tabFromPath("/ui/chat", "/ui")).toBe("chat");
    expect(tabFromPath("/apps/openclaw/sessions", "/apps/openclaw")).toBe("sessions");
  });

  it("returns null for unknown path", () => {
    expect(tabFromPath("/unknown")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(tabFromPath("/CHAT")).toBe("chat");
    expect(tabFromPath("/Overview")).toBe("overview");
  });
});

describe("inferBasePathFromPathname", () => {
  it("returns empty string for root", () => {
    expect(inferBasePathFromPathname("/")).toBe("");
  });

  it("returns empty string for direct tab path", () => {
    expect(inferBasePathFromPathname("/chat")).toBe("");
    expect(inferBasePathFromPathname("/overview")).toBe("");
    expect(inferBasePathFromPathname("/dreaming")).toBe("");
    expect(inferBasePathFromPathname("/dreams")).toBe("");
  });

  it("infers base path from nested paths", () => {
    expect(inferBasePathFromPathname("/ui/chat")).toBe("/ui");
    expect(inferBasePathFromPathname("/apps/openclaw/sessions")).toBe("/apps/openclaw");
  });

  it("handles index.html suffix", () => {
    expect(inferBasePathFromPathname("/index.html")).toBe("");
    expect(inferBasePathFromPathname("/ui/index.html")).toBe("/ui");
  });
});

describe("TAB_GROUPS", () => {
  it("contains all expected groups", () => {
    const labels = TAB_GROUPS.map((g) => g.label);
    expect(labels).toContain("yyVideo");
    expect(labels).toContain("chat");
    expect(labels).toContain("control");
    expect(labels).toContain("agent");
    expect(labels).toContain("settings");
  });

  it("all tabs are unique", () => {
    const allTabs = TAB_GROUPS.flatMap((g) => g.tabs);
    const uniqueTabs = new Set(allTabs);
    expect(uniqueTabs.size).toBe(allTabs.length);
  });

  it("registers remotionStudio at the tail of the `yyVideo` group", () => {
    // videoStudio used to live under `agent` but was relocated next to
    // remoteTerminal so the YYVIDEO surface owns the whole pipeline
    // (server provisioning + Pixelle authoring + Remotion programmatic
    // templates). remotionStudio was appended last because it's the
    // newest surface in the group.
    const yyVideoGroup = TAB_GROUPS.find((g) => g.label === "yyVideo");
    expect(yyVideoGroup).toBeDefined();
    expect(yyVideoGroup?.tabs).toContain("videoStudio");
    expect(yyVideoGroup?.tabs.at(-1)).toBe("remotionStudio");
    const agentGroup = TAB_GROUPS.find((g) => g.label === "agent");
    expect(agentGroup?.tabs).not.toContain("videoStudio");
    expect(agentGroup?.tabs).not.toContain("remotionStudio");
  });

  it("registers remoteTerminal as a top-level entry under yyVideo", () => {
    const yyVideoGroup = TAB_GROUPS.find((g) => g.label === "yyVideo");
    expect(yyVideoGroup).toBeDefined();
    // The legacy "Remote servers" submenu was flattened: remoteTerminal
    // now appears directly under YYVIDEO and renders as
    // "Remote servers" / "ComfyUI 服务器" via tabs.remoteTerminal.
    expect(yyVideoGroup?.submenuLabel).toBeUndefined();
    expect(yyVideoGroup?.tabs).toContain("remoteTerminal");
    expect(yyVideoGroup?.tabs).toContain("videoStudio");
  });
});
