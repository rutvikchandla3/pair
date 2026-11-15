import { useAtom } from "@effect/atom-react";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { SHARED_WITH_YOU_STATE_OPTIONS } from "@t3tools/client-runtime/inbox";
import { activeTeamMembers } from "@t3tools/client-runtime/state/team";
import { EnvironmentId } from "@t3tools/contracts";

import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import {
  NO_SHARED_WITH_YOU_FILTERS,
  hasSharedWithYouFilters,
  myTasksGroupBySpaceAtom,
  sharedWithYouFiltersAtom,
} from "../../state/inbox";
import { useTeamRoster } from "../../state/team";
import { SpaceSheetFrame } from "../spaces/SpaceSheetFrame";

type Params = { readonly environmentId: string };

export function MyTasksFiltersSheet(props: StaticScreenProps<Params>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const [groupBySpace, setGroupBySpace] = useAtom(myTasksGroupBySpaceAtom(environmentId));
  return (
    <SpaceSheetFrame header={{ title: "My tasks", onClose: () => navigation.goBack() }}>
      <ListSection>
        <ListToggleRow
          label="Group by space"
          value={groupBySpace}
          onValueChange={setGroupBySpace}
        />
      </ListSection>
    </SpaceSheetFrame>
  );
}

export function SharedWithYouFiltersSheet(props: StaticScreenProps<Params>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const [filters, setFilters] = useAtom(sharedWithYouFiltersAtom(environmentId));
  const { members, me } = useTeamRoster(environmentId);
  const people = activeTeamMembers(members).filter((member) => member.id !== me);
  return (
    <SpaceSheetFrame
      header={{ title: "Filters", onClose: () => navigation.goBack() }}
      footer={
        hasSharedWithYouFilters(filters) ? (
          <Button
            label="Clear filters"
            tone="text"
            fullWidth
            onPress={() => setFilters(NO_SHARED_WITH_YOU_FILTERS)}
          />
        ) : undefined
      }
    >
      <ListSection title="Person">
        <ListChoiceRow
          label="Everyone"
          selected={filters.personId === null}
          onPress={() => setFilters({ ...filters, personId: null })}
        />
        {people.map((member) => (
          <ListChoiceRow
            key={member.id}
            separated
            label={member.name}
            selected={filters.personId === member.id}
            onPress={() => setFilters({ ...filters, personId: member.id })}
          />
        ))}
      </ListSection>
      <ListSection title="State">
        <ListChoiceRow
          label="Any"
          selected={filters.state === null}
          onPress={() => setFilters({ ...filters, state: null })}
        />
        {SHARED_WITH_YOU_STATE_OPTIONS.map((option) => (
          <ListChoiceRow
            key={option.value}
            separated
            label={option.label}
            selected={filters.state === option.value}
            onPress={() => setFilters({ ...filters, state: option.value })}
          />
        ))}
      </ListSection>
      <ListSection footer="Threads on a space task live in their task.">
        <ListToggleRow
          label="Include task threads"
          value={filters.includeTaskThreads}
          onValueChange={(includeTaskThreads) => setFilters({ ...filters, includeTaskThreads })}
        />
      </ListSection>
    </SpaceSheetFrame>
  );
}
