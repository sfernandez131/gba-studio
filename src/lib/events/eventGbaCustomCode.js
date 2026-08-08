const l10n = require("../helpers/l10n").default;

// M8e (GBA superpowers): "Run Custom Code (C++)" - a GBA-only escape hatch. The
// `code` snippet is emitted verbatim into the generated engine (gba_user_code.h)
// as a function and run here via op 0x9B (VM_USER_CODE). GBA-only (platform
// "gba"); no-ops on GB. Trusted-author / non-portable - the snippet compiles into
// the ROM with full Butano (bn::*) + hw_* + GBA_VAR(idx) access, so a mistake is a
// build error. The eject reads this event's `code` arg; the compile just emits the
// op keyed on the event id (see scriptBuilder.gbaCustomCode).
const id = "EVENT_GBA_CUSTOM_CODE";
const platform = "gba";
const groups = ["EVENT_GROUP_MISC"];

const fields = [
  {
    label: l10n("EVENT_GBA_CUSTOM_CODE_WARN"),
  },
  {
    key: "code",
    label: l10n("FIELD_GBA_CUSTOM_CODE"),
    description: l10n("FIELD_GBA_CUSTOM_CODE_DESC"),
    type: "code",
    flexBasis: "100%",
  },
];

const compile = (input, helpers) => {
  const { gbaCustomCode, event } = helpers;
  gbaCustomCode(event.id);
};

module.exports = {
  id,
  platform,
  description: l10n("EVENT_GBA_CUSTOM_CODE_DESC"),
  groups,
  fields,
  compile,
};
