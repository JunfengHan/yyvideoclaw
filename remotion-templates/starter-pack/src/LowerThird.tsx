// Lower-third — news-style banner at the bottom of a 16:9 frame. Slides in
// from the left, holds, slides out. Transparent backdrop (black fill) so it
// composites cleanly over other footage when exported as video.

import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export interface LowerThirdProps {
  name: string;
  role: string;
  /** Accent colour used for the left bar and role text. */
  accent: string;
}

export const LowerThird = ({ name, role, accent }: LowerThirdProps) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Slide in 0..15, hold, slide out last 15 frames.
  const slideIn = spring({
    frame,
    fps,
    config: { damping: 200, stiffness: 150, mass: 0.9 },
  });
  const exit = interpolate(frame, [durationInFrames - 15, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const slideXPercent = interpolate(slideIn, [0, 1], [-100, 0]) - exit * 100;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 120,
          transform: `translateX(${slideXPercent}%)`,
          display: "flex",
          alignItems: "stretch",
          height: 200,
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        {/* Accent bar */}
        <div style={{ width: 16, backgroundColor: accent }} />
        {/* Text block */}
        <div
          style={{
            backgroundColor: "rgba(17, 24, 39, 0.92)",
            padding: "32px 56px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            minWidth: 520,
          }}
        >
          <div
            style={{
              color: "#f9fafb",
              fontSize: 72,
              fontWeight: 700,
              lineHeight: 1.05,
              marginBottom: 8,
            }}
          >
            {name}
          </div>
          <div
            style={{
              color: accent,
              fontSize: 36,
              fontWeight: 500,
              letterSpacing: 1,
              textTransform: "uppercase",
            }}
          >
            {role}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
