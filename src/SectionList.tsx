import React from "react";
import ReactNative from "react-native";

const createNativeWrapper = require("react-native-gesture-handler/createNativeWrapper")
  .default;

const MEMOIZED = new WeakMap();

function memoizeWrap(Component: any, config: any) {
  if (Component == null) {
    return null;
  }
  let memoized = MEMOIZED.get(Component);
  if (!memoized) {
    memoized = createNativeWrapper(Component, config);
    MEMOIZED.set(Component, memoized);
  }
  return memoized;
}

const ScrollView = () => {
  return memoizeWrap(ReactNative.ScrollView, {
    disallowInterruption: true,
    shouldCancelWhenOutside: false
  });
};

export const SectionList = () => {
  if (!(MEMOIZED as any).SectionList) {
    const ScrollView1 = ScrollView();
    (MEMOIZED as any).SectionList = React.forwardRef((props, ref) => (
      <ReactNative.SectionList
        ref={ref}
        {...props}
        renderScrollComponent={scrollProps => <ScrollView1 {...scrollProps} />}
      />
    ));
  }
  return (MEMOIZED as any).SectionList;
};
