// Social card — 9:16 portrait with a big headline over a tinted frame.
// Designed as a quick "shareable" format for TikTok / Reels / Stories.

import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export interface SocialCardProps {
  headline: string;
  body: string;
  /** Accent colour — the top border + headline highlight. */
  tint: string;
  background: string;
}

export const SocialCard = ({ headline, body, tint, background }: SocialCardProps) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Headline drops in with a spring, body follows ~8 frames later.
  const headlineSpring = spring({
    frame,
    fps,
    config: { damping: 180, stiffness: 130 },
  });
  const headlineY = interpolate(headlineSpring, [0, 1], [-60, 0]);
  const headlineOpacity = interpolate(headlineSpring, [0, 1], [0, 1]);

  const bodySpring = spring({
    frame: frame - 8,
    fps,
    config: { damping: 180, stiffness: 130 },
  });
  const bodyOpacity = interpolate(bodySpring, [0, 1], [0, 1]);
  const bodyY = interpolate(bodySpring, [0, 1], [30, 0]);

  // Gentle Ken-Burns zoom on the backdrop for motion texture.
  const zoom = interpolate(frame, [0, durationInFrames], [1, 1.08]);

  // Fade out in the last 10 frames.
  const exit = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: background, opacity: exit }}>
      {/* Zooming tinted backdrop panel */}
      <AbsoluteFill
        style={{
          transform: `scale(${zoom})`,
          background: `radial-gradient(circle at 30% 20%, ${tint}33, transparent 60%)`,
        }}
      />
      {/* Top tint border */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 24,
          backgroundColor: tint,
        }}
      />
      {/* Content */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "flex-start",
          padding: "0 96px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div
          style={{
            transform: `translateY(${headlineY}px)`,
            opacity: headlineOpacity,
            color: "#f9fafb",
            fontSize: 168,
            fontWeight: 900,
            lineHeight: 1,
            letterSpacing: -3,
            marginBottom: 40,
            // Accent-underline on the headline for visual anchor.
            textDecoration: `underline ${tint}`,
            textDecorationThickness: 12,
            textUnderlineOffset: 20,
          }}
        >
          {headline}
        </div>
        <div
          style={{
            transform: `translateY(${bodyY}px)`,
            opacity: bodyOpacity,
            color: "#d1d5db",
            fontSize: 56,
            fontWeight: 500,
            lineHeight: 1.3,
            maxWidth: 800,
          }}
        >
          {body}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
