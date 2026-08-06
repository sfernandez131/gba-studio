const l10n = require("../helpers/l10n").default;

// M8d (GBA superpowers): set the affine "Mode-7" scene background's rotation
// angle from a variable's value (whole degrees). GBA-only (gated on
// settings.platform === "gba"). Emits VM_SET_BG_ANGLE_VAR (gbavm op 0x99); the
// engine reads the angle from the variable at runtime, so a script can drive
// Mode-7 rotation from any computed value (e.g. steering with L/R). Scale is left
// as set by the Rotate/Scale Background event. The scene must be an affine scene
// (it becomes one when its scripts use the Rotate/Scale Background event).
const id = "EVENT_SET_BACKGROUND_ANGLE";
const platform = "gba";
const groups = ["EVENT_GROUP_SCENE"];

const autoLabel = (fetchArg) => {
  return l10n("EVENT_SET_BACKGROUND_ANGLE_LABEL", {
    variable: fetchArg("angle"),
  });
};

const fields = [
  {
    label: l10n("EVENT_SET_BACKGROUND_ANGLE_DESC"),
  },
  {
    key: "angle",
    label: l10n("FIELD_VARIABLE"),
    description: l10n("FIELD_BACKGROUND_ANGLE_VARIABLE_DESC"),
    type: "variable",
    defaultValue: "LAST_VARIABLE",
  },
];

const compile = (input, helpers) => {
  const { setBackgroundAngleToVariable } = helpers;
  setBackgroundAngleToVariable(input.angle);
};

module.exports = {
  id,
  platform,
  description: l10n("EVENT_SET_BACKGROUND_ANGLE_DESC"),
  autoLabel,
  groups,
  fields,
  compile,
};
