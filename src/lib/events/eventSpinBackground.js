const l10n = require("../helpers/l10n").default;

// M8d (GBA superpowers): continuously spin the affine "Mode-7" scene background.
// GBA-only event (gated on settings.platform === "gba"). Emits VM_SET_BG_SPIN
// (gbavm op 0x98), which sets a per-frame angular velocity the engine applies
// every frame until changed (0 stops it). Composes with the Rotate/Scale event,
// which sets the base angle. The scene must be an affine scene (it becomes one
// when its scripts use the Rotate/Scale Background event).
const id = "EVENT_SPIN_BACKGROUND";
const platform = "gba";
const groups = ["EVENT_GROUP_SCENE"];

const autoLabel = (fetchArg) => {
  return l10n("EVENT_SPIN_BACKGROUND_LABEL", {
    speed: fetchArg("speed"),
  });
};

const fields = [
  {
    label: l10n("EVENT_SPIN_BACKGROUND_DESC"),
  },
  {
    key: "speed",
    label: l10n("FIELD_SPIN_SPEED"),
    description: l10n("FIELD_SPIN_SPEED_DESC"),
    type: "number",
    min: -90,
    max: 90,
    step: 1,
    defaultValue: 2,
  },
];

const compile = (input, helpers) => {
  const { spinBackground } = helpers;
  spinBackground(input.speed);
};

module.exports = {
  id,
  platform,
  description: l10n("EVENT_SPIN_BACKGROUND_DESC"),
  autoLabel,
  groups,
  fields,
  compile,
};
