// Title card — fade-up headline + subtitle over a solid backdrop with a
// single accent bar. Suitable for video intros / product promos.

import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export interface TitleCardProps {
  title: string;
  subtitle: string;
  /** Accent colour — the vertical bar + subtitle highlight. */
  tint: string;
  /** Backdrop colour. */
  background: string;
}

export const TitleCard = ({ title, subtitle, tint, background }: TitleCardProps) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Springy title entrance on the first ~15 frames.
  const titleLift = spring({
    frame,
    fps,
    config: { damping: 200, stiffness: 120, mass: 0.8 },
  });
  const titleY = interpolate(titleLift, [0, 1], [40, 0]);
  const titleOpacity = interpolate(titleLift, [0, 1], [0, 1]);

  // Subtitle trails the title by ~6 frames.
  const subtitleLift = spring({
    frame: frame - 6,
    fps,
    config: { damping: 200, stiffness: 120, mass: 0.8 },
  });
  const subtitleY = interpolate(subtitleLift, [0, 1], [30, 0]);
  const subtitleOpacity = interpolate(subtitleLift, [0, 1], [0, 1]);

  // Accent bar grows from 0 → full width across frames 0..20.
  const barWidth = interpolate(frame, [0, 20], [0, 120], {
    extrapolateRight: "clamp",
  });

  // Fade everything out in the last 10 frames.
  const exitOpacity = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: background,
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "0 120px",
        opacity: exitOpacity,
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          height: 6,
          width: barWidth,
          backgroundColor: tint,
          marginBottom: 36,
          borderRadius: 3,
        }}
      />
      <div
        style={{
          transform: `translateY(${titleY}px)`,
          opacity: titleOpacity,
          color: "#f9fafb",
          fontSize: 144,
          fontWeight: 800,
          letterSpacing: -2,
          lineHeight: 1,
          marginBottom: 24,
        }}
      >
        {title}
      </div>
      <div
        style={{
          transform: `translateY(${subtitleY}px)`,
          opacity: subtitleOpacity,
          color: tint,
          fontSize: 56,
          fontWeight: 500,
          letterSpacing: -0.5,
        }}
      >
        {subtitle}
      </div>
    </AbsoluteFill>
  );
};
