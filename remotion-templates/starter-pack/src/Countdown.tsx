// Countdown — N → 0 integer countdown with a springy scale pulse every
// second. Square (1080x1080) so it works on stories and posts alike.

import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export interface CountdownProps {
  /** Number to count down from (integer >= 1). */
  start: number;
  tint: string;
  background: string;
}

export const Countdown = ({ start, tint, background }: CountdownProps) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // One tick per fps frames. Floor so the displayed number decrements cleanly.
  const secondsElapsed = Math.floor(frame / fps);
  const displayed = Math.max(start - secondsElapsed, 0);

  // Local frame within the current second (0..fps-1) drives the pulse.
  const localFrame = frame % fps;
  const pulse = spring({
    frame: localFrame,
    fps,
    config: { damping: 12, stiffness: 180, mass: 0.6 },
  });
  const scale = interpolate(pulse, [0, 1], [1.25, 1]);

  // Final "0" gets a longer hold + quick fade so the video ends cleanly.
  const endFade = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0.4], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: background,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Outer ring */}
      <div
        style={{
          width: 540,
          height: 540,
          borderRadius: "50%",
          border: `12px solid ${tint}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${scale})`,
          opacity: endFade,
        }}
      >
        <div
          style={{
            color: "#f9fafb",
            fontSize: 360,
            fontWeight: 800,
            lineHeight: 1,
            // Use tabular numerals where available so the digits don't jitter
            // sideways when widths change (3 → 2, etc.).
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {displayed}
        </div>
      </div>
    </AbsoluteFill>
  );
};
