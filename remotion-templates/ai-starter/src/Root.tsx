// Root composition registry for the AI Create starter.
//
// This placeholder ships a single always-valid composition so that
// `bundle + selectComposition + render-still` succeeds out of the box.
// The AI agent is expected to REPLACE this file with its own
// <Composition> entries that match the user's prompt.
//
// Contract for the agent (see .skills/ for the full Remotion writing
// guide):
//   * Keep this filename (`src/Root.tsx`) and the default export shape.
//   * Register at least one <Composition> with a stable `id`.
//   * `durationInFrames`, `fps`, `width`, `height` are REQUIRED.
//   * Remotion hooks (`useCurrentFrame`, `useVideoConfig`, `spring`,
//     `interpolate`) are the idiomatic animation primitives.

import React from "react";
import { AbsoluteFill, Composition, interpolate, useCurrentFrame } from "remotion";

export interface PlaceholderProps {
  readonly title: string;
  readonly background: string;
  readonly tint: string;
}

const Placeholder: React.FC<PlaceholderProps> = ({ title, background, tint }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        background,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div
        style={{
          opacity,
          color: tint,
          fontSize: 96,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          textAlign: "center",
          padding: "0 64px",
        }}
      >
        {title}
      </div>
    </AbsoluteFill>
  );
};

export const Root: React.FC = () => {
  return (
    <>
      <Composition<typeof Placeholder, PlaceholderProps>
        id="Main"
        component={Placeholder}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          title: "Replace me with your video",
          background: "#0f172a",
          tint: "#f97316",
        }}
      />
    </>
  );
};
