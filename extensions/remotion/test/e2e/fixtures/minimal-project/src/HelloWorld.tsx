import { AbsoluteFill } from "remotion";

export interface HelloWorldProps {
  tint: string;
}

// Intentionally trivial: a single solid-colour frame. The point of the e2e
// fixture is to validate the OpenClaw plugin pipeline end-to-end, not to
// exercise Remotion's animation features.
export const HelloWorld = ({ tint }: HelloWorldProps) => {
  return <AbsoluteFill style={{ backgroundColor: tint }} />;
};
