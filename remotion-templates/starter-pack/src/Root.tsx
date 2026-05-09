// Root composition registry. Each <Composition> entry becomes a selectable
// template in the Remotion Studio UI. Keep the ids stable — they're referenced
// from studio.json (for metadata) and from any automation that renders these
// templates by id.

import { Composition } from "remotion";
import { Countdown, type CountdownProps } from "./Countdown";
import { LowerThird, type LowerThirdProps } from "./LowerThird";
import { SocialCard, type SocialCardProps } from "./SocialCard";
import { TitleCard, type TitleCardProps } from "./TitleCard";

export const Root = () => {
  return (
    <>
      <Composition<typeof TitleCard, TitleCardProps>
        id="TitleCard"
        component={TitleCard}
        // 1080p 16:9 · 5s @ 30fps — a common promo intro length.
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          title: "yyvideoclaw",
          subtitle: "Local-first AI video studio",
          tint: "#ef4444",
          background: "#0f172a",
        }}
      />
      <Composition<typeof Countdown, CountdownProps>
        id="Countdown"
        component={Countdown}
        // 1080p 1:1 · 5s @ 30fps — counts down from N to 0.
        durationInFrames={150}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          start: 5,
          tint: "#22c55e",
          background: "#111827",
        }}
      />
      <Composition<typeof LowerThird, LowerThirdProps>
        id="LowerThird"
        component={LowerThird}
        // 1080p 16:9 · 3s @ 30fps — news-style lower-third banner.
        durationInFrames={90}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          name: "Jane Doe",
          role: "Lead Engineer",
          accent: "#3b82f6",
        }}
      />
      <Composition<typeof SocialCard, SocialCardProps>
        id="SocialCard"
        component={SocialCard}
        // 9:16 portrait · 4s @ 30fps — short-form social card.
        durationInFrames={120}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          headline: "Ship faster.",
          body: "Programmatic video, rendered locally.",
          tint: "#f97316",
          background: "#111827",
        }}
      />
    </>
  );
};
