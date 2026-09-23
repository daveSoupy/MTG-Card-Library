import { useMemo, useState } from 'react';
import {
  createLocation, updateLocation,
  LOCATION_KINDS, LOCATION_KIND_LABEL, LOCATION_KIND_PLURAL,
  type LocationKind, type LocationRestore, type StorageLocation,
} from '../api.ts';
import type { UndoEntry } from '../undo.ts';
import { LocationDeleteConfirm } from './LocationDeleteConfirm.tsx';
import { nameMatches } from '../listSort.ts';
import { count } from '../format.ts';

/** Past this many, the list gets a filter box. */
const FILTER_FROM = 8;

const kindOf = (location: StorageLocation): LocationKind =>
  (LOCATION_KINDS as readonly string[]).includes(location.kind) ? location.kind as LocationKind : 'other';

/**
 * The collection's location sidebar, built for forty-odd locations rather
 * than four.
 *
 * - Grouped by kind (binders, boxes, deck boxes…), with archived locations
 *   folded away at the bottom — their cards no longer count as owned.
 * - "+" at the top opens the new-location form, with a kind, so it is never
 *   below the fold.
 * - Each row has one quiet "Edit" instead of a ×: rename, change kind,
 *   archive, and — from inside that — delete, which still goes through the
 *   confirm that says where the cards will go.
 * - A long name is cut with an ellipsis and carries its full name as a title.
 *
 * Every edit returns the whole list from the server, which the page puts in
 * its state, so the lot selects and the add dialogs pick up a rename at once.
 */
export function LocationList({
  locations,
  selected,
  onSelect,
  everywhereCount,
  onLocations,
  onDeleted,
  record,
  onError,
}: {
  locations: StorageLocation[];
  selected: number | undefined;
  onSelect: (id: number | undefined) => void;
  /** The "Everywhere" row's count, or null while the value is unknown. */
  everywhereCount: number | null;
  onLocations: (locations: StorageLocation[]) => void;
  onDeleted: (name: string, result: { locations: StorageLocation[]; restore: LocationRestore }) => void;
  /** Adds an edit to the collection page's undo stack. */
  record: (entry: UndoEntry) => void;
  onError: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<LocationKind>('binder');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { groups, archived } = useMemo(() => {
    const matching = locations.filter((l) => nameMatches(l.name, filter));
    const live = matching.filter((l) => !l.is_archived);
    return {
      groups: LOCATION_KINDS
        .map((kind) => ({ kind, items: live.filter((l) => kindOf(l) === kind) }))
        .filter((group) => group.items.length > 0),
      archived: matching.filter((l) => l.is_archived),
    };
  }, [locations, filter]);

  const fail = (e: unknown) => onError(e instanceof Error ? e.message : String(e));

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      onLocations(await createLocation(name, newKind));
      setNewName('');
      setAdding(false);
    } catch (e) { fail(e); }
  };

  /** Saves an edit and puts its reverse on the undo stack. */
  const save = async (
    location: StorageLocation,
    changes: { name?: string; kind?: LocationKind; isArchived?: boolean },
  ) => {
    const before = {
      name: location.name, kind: kindOf(location), isArchived: Boolean(location.is_archived),
    };
    const revert = Object.fromEntries(
      Object.keys(changes).map((key) => [key, before[key as keyof typeof before]]),
    ) as typeof changes;
    try {
      onLocations(await updateLocation(location.id, changes));
      setEditing(null);
      const label = changes.isArchived !== undefined && changes.name === undefined && changes.kind === undefined
        ? `${changes.isArchived ? 'archiving' : 'unarchiving'} ${location.name}`
        : `editing ${location.name}`;
      record({
        label,
        undo: async () => onLocations(await updateLocation(location.id, revert)),
        redo: async () => onLocations(await updateLocation(location.id, changes)),
      });
    } catch (e) { fail(e); }
  };

  const row = (location: StorageLocation) => (
    <div className="loc-row" key={location.id}>
      <button
        className={`loc${selected === location.id ? ' on' : ''}`}
        onClick={() => onSelect(location.id)}
        title={location.name}
      >
        <span>{location.name}</span>
        <span className="count">{count(location.card_count)}</span>
      </button>
      <button
        className="loc-edit"
        onClick={() => { setConfirmingDelete(null); setEditing(editing === location.id ? null : location.id); }}
        disabled={deleting}
        aria-expanded={editing === location.id}
        aria-label={`Edit ${location.name}`}
        title="Rename, change kind, archive or delete"
      >
        ⋯
      </button>
      {editing === location.id && (
        <LocationEditor
          location={location}
          onSave={(changes) => save(location, changes)}
          onCancel={() => setEditing(null)}
          onDelete={location.is_default ? undefined : () => { setEditing(null); setConfirmingDelete(location.id); }}
        />
      )}
      {confirmingDelete === location.id && (
        <LocationDeleteConfirm
          location={location}
          locations={locations}
          onCancel={() => setConfirmingDelete(null)}
          onBusy={setDeleting}
          onDeleted={(result) => { setConfirmingDelete(null); onDeleted(location.name, result); }}
        />
      )}
    </div>
  );

  return (
    <div className="fgroup loc-list">
      <div className="loc-list-head">
        <h3>Locations</h3>
        <button
          className="loc-add-toggle"
          onClick={() => setAdding((open) => !open)}
          aria-expanded={adding}
          aria-label="New location"
          title="New location"
        >
          {adding ? '×' : '+'}
        </button>
      </div>

      {adding && (
        <form className="loc-new" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name, e.g. Red binder"
            aria-label="New location name"
            autoFocus
          />
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as LocationKind)}
                  aria-label="New location kind">
            {LOCATION_KINDS.map((kind) => <option key={kind} value={kind}>{LOCATION_KIND_LABEL[kind]}</option>)}
          </select>
          <button className="btn small" type="submit" disabled={!newName.trim()}>Add</button>
        </form>
      )}

      {locations.length > FILTER_FROM && (
        <input
          className="loc-filter"
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${count(locations.length)} locations`}
          aria-label="Filter locations"
        />
      )}

      <button className={`loc${selected === undefined ? ' on' : ''}`} onClick={() => onSelect(undefined)}>
        <span>Everywhere</span>
        <span className="count">{everywhereCount === null ? '—' : count(everywhereCount)}</span>
      </button>

      {groups.map((group) => (
        <div key={group.kind} className="loc-group">
          {/* One kind needs no heading — it would only repeat itself. */}
          {groups.length > 1 && (
            <h4 className="loc-kind">
              {LOCATION_KIND_PLURAL[group.kind]} <span className="count">{group.items.length}</span>
            </h4>
          )}
          {group.items.map(row)}
        </div>
      ))}

      {archived.length > 0 && (
        <details className="loc-group loc-archived" open={archived.some((l) => l.id === selected) || undefined}>
          <summary className="loc-kind">
            Archived <span className="count">{archived.length}</span>
          </summary>
          <p className="note">Cards here are kept but no longer count as owned for decks.</p>
          {archived.map(row)}
        </details>
      )}

      {filter.trim() && groups.length === 0 && archived.length === 0 && (
        <p className="note">No location matches “{filter.trim()}”.</p>
      )}
    </div>
  );
}

/** The inline form under a row: name, kind, archive, and the way to delete. */
function LocationEditor({ location, onSave, onCancel, onDelete }: {
  location: StorageLocation;
  onSave: (changes: { name?: string; kind?: LocationKind; isArchived?: boolean }) => void;
  onCancel: () => void;
  /** Absent for the default location, which cannot be deleted. */
  onDelete?: () => void;
}) {
  const [name, setName] = useState(location.name);
  const [kind, setKind] = useState<LocationKind>(kindOf(location));
  const [archivedNow, setArchivedNow] = useState(Boolean(location.is_archived));

  const changes: { name?: string; kind?: LocationKind; isArchived?: boolean } = {};
  if (name.trim() && name.trim() !== location.name) changes.name = name.trim();
  if (kind !== kindOf(location)) changes.kind = kind;
  if (archivedNow !== Boolean(location.is_archived)) changes.isArchived = archivedNow;
  const dirty = Object.keys(changes).length > 0;

  return (
    <form
      className="loc-editor"
      aria-label={`Edit ${location.name}`}
      onSubmit={(e) => { e.preventDefault(); if (dirty) onSave(changes); }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Location name" autoFocus />
      <select value={kind} onChange={(e) => setKind(e.target.value as LocationKind)} aria-label="Location kind">
        {LOCATION_KINDS.map((k) => <option key={k} value={k}>{LOCATION_KIND_LABEL[k]}</option>)}
      </select>
      {/* The default location is where incoming trade cards land, so it
          stays on the shelf. */}
      {!location.is_default && (
        <label className="check" title="Its cards stay where they are but stop counting as owned for decks">
          <input type="checkbox" checked={archivedNow} onChange={(e) => setArchivedNow(e.target.checked)} />
          Archived
        </label>
      )}
      <div className="btnrow">
        <button className="btn small" type="submit" disabled={!dirty}>Save</button>
        <button className="btn secondary small" type="button" onClick={onCancel}>Cancel</button>
        {onDelete && (
          <button className="linkish danger" type="button" onClick={onDelete}>Delete…</button>
        )}
      </div>
    </form>
  );
}
