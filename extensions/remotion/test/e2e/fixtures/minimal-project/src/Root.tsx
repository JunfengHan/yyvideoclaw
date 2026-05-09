import { Composition } from "remotion";
import { HelloWorld } from "./HelloWorld";

export const Root = () => {
  return (
    <>
      <Composition
        id="HelloWorld"
        component={HelloWorld}
        durationInFrames={30}
        fps={30}
        width={320}
        height={180}
        defaultProps={{ tint: "#3b82f6" }}
      />
    </>
  );
};
