const l10n = require("../helpers/l10n").default;

// M8d (GBA superpowers): rotate / scale the affine "Mode-7" scene background.
// GBA-only event (gated on settings.platform === "gba"). Emits
// VM_SET_BG_TRANSFORM (gbavm op 0x97) with a whole-degree angle and a percentage
// scale (100% = the authored size). The scene must be an affine scene, which the
// GBA eject detects by the presence of this event in the scene's scripts.
const id = "EVENT_SET_BACKGROUND_TRANSFORM";
const platform = "gba";
const groups = ["EVENT_GROUP_SCENE"];

const autoLabel = (fetchArg) => {
  return l10n("EVENT_SET_BACKGROUND_TRANSFORM_LABEL", {
    angle: fetchArg("angle"),
    scale: fetchArg("scale"),
  });
};

const fields = [
  {
    label: l10n("EVENT_SET_BACKGROUND_TRANSFORM_DESC"),
  },
  {
    key: "angle",
    label: l10n("FIELD_ANGLE"),
    description: l10n("FIELD_BACKGROUND_TRANSFORM_ANGLE_DESC"),
    type: "number",
    min: 0,
    max: 359,
    step: 1,
    width: "50%",
    unitsField: "angleUnits",
    unitsDefault: "degrees",
    unitsAllowed: ["degrees"],
    defaultValue: 0,
  },
  {
    key: "scale",
    label: l10n("FIELD_SCALE"),
    description: l10n("FIELD_BACKGROUND_TRANSFORM_SCALE_DESC"),
    type: "number",
    min: 25,
    max: 400,
    step: 1,
    width: "50%",
    defaultValue: 100,
  },
];

const compile = (input, helpers) => {
  const { setBackgroundTransform } = helpers;
  setBackgroundTransform(input.angle, input.scale);
};

module.exports = {
  id,
  platform,
  description: l10n("EVENT_SET_BACKGROUND_TRANSFORM_DESC"),
  autoLabel,
  groups,
  fields,
  compile,
};
