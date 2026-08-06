const l10n = require("../helpers/l10n").default;

// M8d (GBA superpowers): set the affine "Mode-7" scene background's scale from a
// variable's value, a percentage (100 = the authored size). GBA-only (gated on
// settings.platform === "gba"). Emits VM_SET_BG_SCALE_VAR (gbavm op 0x9A); the
// engine reads the percentage from the variable at runtime, so a script can drive
// Mode-7 zoom from any computed value. Rotation is left as set by the Rotate/Scale
// Background event. The scene must be an affine scene (it becomes one when its
// scripts use the Rotate/Scale Background event).
const id = "EVENT_SET_BACKGROUND_SCALE";
const platform = "gba";
const groups = ["EVENT_GROUP_SCENE"];

const autoLabel = (fetchArg) => {
  return l10n("EVENT_SET_BACKGROUND_SCALE_LABEL", {
    variable: fetchArg("scale"),
  });
};

const fields = [
  {
    label: l10n("EVENT_SET_BACKGROUND_SCALE_DESC"),
  },
  {
    key: "scale",
    label: l10n("FIELD_VARIABLE"),
    description: l10n("FIELD_BACKGROUND_SCALE_VARIABLE_DESC"),
    type: "variable",
    defaultValue: "LAST_VARIABLE",
  },
];

const compile = (input, helpers) => {
  const { setBackgroundScaleToVariable } = helpers;
  setBackgroundScaleToVariable(input.scale);
};

module.exports = {
  id,
  platform,
  description: l10n("EVENT_SET_BACKGROUND_SCALE_DESC"),
  autoLabel,
  groups,
  fields,
  compile,
};
