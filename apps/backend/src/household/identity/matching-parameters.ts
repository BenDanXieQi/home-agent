import { identityCapacity } from "@home-agent/api/contracts";
// Fixed matching parameters; feature similarity is not an identity probability.
export const identityMatchingParameters = {
  matchingVersion: "7e34f213-276a-4c40-bd28-5f9b737c8847",
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
