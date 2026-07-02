import React, { useCallback } from "react";
import l10n from "shared/lib/lang/l10n";
import settingsActions from "store/features/settings/settingsActions";
import { Select } from "ui/form/Select";
import { SearchableSettingRow } from "ui/form/SearchableSettingRow";
import { SettingRowInput, SettingRowLabel } from "ui/form/SettingRow";
import { CardAnchor, CardHeading } from "ui/cards/Card";
import { SearchableCard } from "ui/cards/SearchableCard";
import { PlatformSetting } from "shared/lib/resources/types";
import { useAppDispatch, useAppSelector } from "store/hooks";
import { SingleValue } from "react-select";

interface SettingsSectionPlatformProps {
  searchTerm: string;
}

interface PlatformOption {
  value: PlatformSetting;
  label: string;
}

export const SettingsSectionPlatform = ({
  searchTerm,
}: SettingsSectionPlatformProps) => {
  const dispatch = useAppDispatch();

  const platform =
    useAppSelector((state) => state.project.present.settings.platform) || "gb";

  const platformOptions: PlatformOption[] = [
    {
      value: "gb",
      label: l10n("FIELD_PLATFORM_GB"),
    },
    {
      value: "gba",
      label: l10n("FIELD_PLATFORM_GBA"),
    },
  ];

  const onChangePlatform = useCallback(
    (platform: PlatformSetting) => {
      dispatch(settingsActions.editSettings({ platform }));
    },
    [dispatch],
  );

  const currentValue =
    platformOptions.find((option) => option.value === platform) ||
    platformOptions[0];

  return (
    <SearchableCard
      searchTerm={searchTerm}
      searchMatches={[l10n("SETTINGS_PLATFORM"), l10n("FIELD_PLATFORM_GBA")]}
    >
      <CardAnchor id="settingsPlatform" />
      <CardHeading>{l10n("SETTINGS_PLATFORM")}</CardHeading>
      <SearchableSettingRow
        searchTerm={searchTerm}
        searchMatches={[l10n("SETTINGS_PLATFORM")]}
      >
        <SettingRowLabel>{l10n("FIELD_PLATFORM")}</SettingRowLabel>
        <SettingRowInput>
          <Select
            value={currentValue}
            options={platformOptions}
            onChange={(newValue: SingleValue<PlatformOption>) => {
              if (newValue) {
                onChangePlatform(newValue.value);
              }
            }}
          />
        </SettingRowInput>
      </SearchableSettingRow>
    </SearchableCard>
  );
};
