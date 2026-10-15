import { identityCapacity } from "@home-agent/api/contracts";
export const identityMatchingParameters = {
  classes: {
    human: {
      threshold: 0.363,
      margin: 0.08,
      featureDimensions: identityCapacity.featureDimensions,
    },
    cat: {
      threshold: 0.7,
      margin: 0.08,
      featureDimensions: identityCapacity.petFeatureDimensions,
    },
    dog: {
      threshold: 0.7,
      margin: 0.08,
      featureDimensions: identityCapacity.petFeatureDimensions,
    },
  },
} as const;
