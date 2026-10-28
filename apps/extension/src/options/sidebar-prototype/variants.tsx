// PROTOTYPE for issue #344. Three structurally different Watches sidebars over the same fake data.
// Every variant lists both logins' Watches together, as #343 made the page do.
import { useState, type ReactNode } from 'react';
import { Avatar } from '../avatar.tsx';
import {
  applyFilter,
  attentionOf,
  inboxOf,
  isWatch,
  manyOwners,
  mib,
  OWNER_LABEL,
  ownersWithWatches,
  relativeUntil,
  watchStatus,
  type Filter,
  type Login,
  type ProtoWatch,
  type SidebarProps,
} from './data.ts';

export interface VariantProps extends SidebarProps {
  readonly feed: ReactNode;
  readonly inspector: ReactNode;
}

const percent = ({ storage }: SidebarProps) =>
  Math.min(100, (storage.usedBytes / storage.budgetBytes) * 100);

const loginNote = (props: SidebarProps, login: Login) =>
  login === 'linked' && props.linkState === 'ended' ? 'Signed out' : `@${props.names[login]}`;

function Meter(props: SidebarProps) {
  return (
    <div className="opt-bar">
      <div style={{ width: `${percent(props)}%` }} />
    </div>
  );
}

function Logo() {
  return (
    <div className="opt-title">
      <div className="ext-logo pv-logo-sm">
        Gram<em>Grab</em>
      </div>
      <span className="opt-beta">Beta</span>
    </div>
  );
}

function ScheduleLines(props: SidebarProps) {
  const entries = Object.entries(props.nextCheckAt) as [Login, number][];
  return (
    <>
      {entries.map(([login, at]) => (
        <p key={login} className="opt-meta">
          {entries.length > 1 && `${OWNER_LABEL[login]}: `}next check {relativeUntil(at)}
        </p>
      ))}
      <p className="opt-meta">
        Storage {mib(props.storage.usedBytes)} of {mib(props.storage.budgetBytes)} MiB
      </p>
      <Meter {...props} />
    </>
  );
}

/** "next check in 41m": the soonest login's, since that is when something can next change. */
const soonest = (props: SidebarProps) =>
  relativeUntil(Math.min(...Object.values(props.nextCheckAt)));

function Row({
  item,
  tagged,
  active,
  onOpen,
}: {
  item: ProtoWatch;
  tagged: boolean;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      className={`opt-item pv-row ${active ? 'active' : ''} ${item.enabled && !item.held ? '' : 'opt-dim'}`}
      onClick={onOpen}
      title={`@${item.username}`}
    >
      <Avatar src={undefined} username={item.username} size="md" />
      <span className="opt-account-text opt-grow">
        <span className="pv-clamp">@{item.username}</span>
        <span className="opt-meta">
          {tagged && (
            <span className={`opt-owner opt-owner-${item.owner}`}>{OWNER_LABEL[item.owner]}</span>
          )}
          {watchStatus(item)}
        </span>
      </span>
      {item.attention > 0 && item.enabled && !item.held && <span className="opt-dot" />}
    </button>
  );
}

function Rows({ props, watches }: { props: SidebarProps; watches: readonly ProtoWatch[] }) {
  const tagged = manyOwners(props.watches);
  return (
    <>
      {watches.map(item => (
        <Row
          key={item.watchId}
          item={item}
          tagged={tagged}
          active={isWatch(props.view, item.watchId)}
          onOpen={() => props.onGo({ watchId: item.watchId })}
        />
      ))}
    </>
  );
}

function FilterTabs({
  props,
  filter,
  onChange,
}: {
  props: SidebarProps;
  filter: Filter;
  onChange: (filter: Filter) => void;
}) {
  const owning = ownersWithWatches(props.watches);
  if (!manyOwners(props.watches)) return null;
  return (
    <div className="opt-filter pv-filter-tabs" role="group" aria-label="Show Watches of">
      {(['all', ...owning] as const).map(value => (
        <button key={value} aria-pressed={filter === value} onClick={() => onChange(value)}>
          {value === 'all' ? 'All' : OWNER_LABEL[value]}
        </button>
      ))}
    </div>
  );
}

/* ─── A: one compact Logins control, list fills, schedule and storage collapsed ─── */

function LoginsMenu(props: SidebarProps) {
  const [open, setOpen] = useState(false);
  const linked = props.linkState !== 'unlinked';
  return (
    <div className="pv-menu-anchor">
      <button className="pv-switcher" onClick={() => setOpen(!open)}>
        <span className="pv-stack">
          <Avatar src={undefined} username={props.names.main} size="sm" />
          {linked && (
            <span className={props.linkState === 'ended' ? 'pv-ended' : ''}>
              <Avatar src={undefined} username={props.names.linked} size="sm" />
            </span>
          )}
        </span>
        <span className="opt-grow pv-truncate">
          {linked ? (
            <>
              @{props.names.main}
              <span className="opt-meta">
                {props.linkState === 'ended'
                  ? '+ linked login, signed out'
                  : `+ @${props.names.linked}`}
              </span>
            </>
          ) : (
            <>@{props.names.main}</>
          )}
        </span>
        {props.linkState === 'ended' && <span className="opt-dot" />}
        <span className="pv-caret">▾</span>
      </button>
      {open && (
        <div className="pv-menu">
          {(['main', 'linked'] as const)
            .filter(login => login === 'main' || linked)
            .map(login => (
              <div key={login} className="pv-menu-item pv-menu-static">
                <Avatar src={undefined} username={props.names[login]} size="sm" />
                <span className="pv-wrap opt-grow">
                  <span className="opt-meta">{OWNER_LABEL[login]} login</span>
                  {loginNote(props, login)}
                </span>
              </div>
            ))}
          <div className="pv-menu-rule" />
          {props.linkState !== 'linked' && (
            <button className="pv-menu-item" onClick={props.onLink}>
              {props.linkState === 'ended' ? 'Link this login again' : '+ Link a second login'}{' '}
              <span className="opt-beta">Beta</span>
            </button>
          )}
          {linked && (
            <button className="pv-menu-item opt-danger" onClick={props.onUnlink}>
              Unlink linked login
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function VariantA(props: VariantProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const shown = applyFilter(props.watches, filter);
  const attention = attentionOf(props.watches);
  return (
    <div className="opt-console">
      <nav className="opt-list pv-col">
        <div className="pv-a-head">
          <Logo />
          <LoginsMenu {...props} />
        </div>
        <div className="pv-seg">
          <button
            className={props.view === 'attention' ? 'active' : ''}
            onClick={() => props.onGo('attention')}
          >
            Needs you{' '}
            {attention > 0 && <span className="opt-count opt-count-error">{attention}</span>}
          </button>
          <button
            className={props.view === 'inbox' ? 'active' : ''}
            onClick={() => props.onGo('inbox')}
          >
            Inbox <span className="opt-count">{inboxOf(props.watches)}</span>
          </button>
        </div>
        <div className="pv-list-head">
          <span className="opt-label">Watches ({shown.length})</span>
          <button className="opt-btn pv-add" onClick={() => props.onGo('new')}>
            + Add
          </button>
        </div>
        <FilterTabs props={props} filter={filter} onChange={setFilter} />
        <div className="pv-scroll">
          <Rows props={props} watches={shown} />
        </div>
        <details className="pv-foot">
          <summary>
            Next check {soonest(props)} · {percent(props).toFixed(0)}% storage
          </summary>
          <ScheduleLines {...props} />
        </details>
        <button
          className={`pv-foot-link ${props.view === 'transfer' ? 'active' : ''}`}
          onClick={() => props.onGo('transfer')}
        >
          Export or import Watches
        </button>
      </nav>
      {props.feed}
      {props.inspector}
    </div>
  );
}

/* ─── B: the login chips are the filter, and each row's avatar carries its owner's badge ─── */

function BadgedRow({
  props,
  item,
  tagged,
}: {
  props: SidebarProps;
  item: ProtoWatch;
  tagged: boolean;
}) {
  return (
    <button
      className={`opt-item pv-row ${isWatch(props.view, item.watchId) ? 'active' : ''} ${item.enabled && !item.held ? '' : 'opt-dim'}`}
      onClick={() => props.onGo({ watchId: item.watchId })}
      title={`@${item.username} (${OWNER_LABEL[item.owner]})`}
    >
      <span className="pv-badged">
        <Avatar src={undefined} username={item.username} size="md" />
        {tagged && (
          <span
            className={`pv-owner-badge pv-owner-${item.owner}`}
            role="img"
            aria-label={`Owned by ${OWNER_LABEL[item.owner]}`}
          >
            {item.owner === 'other' ? '?' : OWNER_LABEL[item.owner].charAt(0)}
          </span>
        )}
      </span>
      <span className="opt-account-text opt-grow">
        <span className="pv-clamp">@{item.username}</span>
        <span className="opt-meta">{watchStatus(item)}</span>
      </span>
      {item.attention > 0 && item.enabled && !item.held && <span className="opt-dot" />}
    </button>
  );
}

function VariantB(props: VariantProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [menu, setMenu] = useState(false);
  const [info, setInfo] = useState(false);
  const shown = applyFilter(props.watches, filter);
  const attention = attentionOf(props.watches);
  const tagged = manyOwners(props.watches);
  const linked = props.linkState !== 'unlinked';
  return (
    <div className="opt-console">
      <nav className="opt-list pv-col">
        <div className="pv-b-head">
          <Logo />
          <div className="pv-b-tabs">
            <button
              className={props.view === 'attention' ? 'active' : ''}
              title="Needs you"
              onClick={() => props.onGo('attention')}
            >
              !{attention > 0 && <span className="pv-badge pv-badge-error">{attention}</span>}
            </button>
            <button
              className={props.view === 'inbox' ? 'active' : ''}
              title="All inbox"
              onClick={() => props.onGo('inbox')}
            >
              ▤<span className="pv-badge">{inboxOf(props.watches)}</span>
            </button>
          </div>
        </div>
        <div className="pv-b-logins">
          {(['main', 'linked'] as const)
            .filter(login => login === 'main' || linked)
            .map(login => (
              <button
                key={login}
                className="pv-b-login"
                aria-pressed={filter === login}
                title={
                  filter === login ? 'Show every Watch' : `Show only ${OWNER_LABEL[login]} Watches`
                }
                onClick={() => setFilter(filter === login ? 'all' : login)}
              >
                <span className="pv-badged">
                  <span
                    className={login === 'linked' && props.linkState === 'ended' ? 'pv-ended' : ''}
                  >
                    <Avatar src={undefined} username={props.names[login]} size="sm" />
                  </span>
                  {tagged && (
                    <span
                      className={`pv-owner-badge pv-owner-${login}`}
                      role="img"
                      aria-label={`${OWNER_LABEL[login]} login`}
                    >
                      {OWNER_LABEL[login].charAt(0)}
                    </span>
                  )}
                </span>
                <span className="pv-truncate pv-chip-name" title={loginNote(props, login)}>
                  {loginNote(props, login)}
                </span>
                <span className="opt-count">
                  {props.watches.filter(item => item.owner === login).length}
                </span>
              </button>
            ))}
          <div className="pv-menu-anchor pv-b-more">
            <button className="pv-icon-btn" title="Logins" onClick={() => setMenu(!menu)}>
              ⋯
            </button>
            {menu && (
              <div className="pv-menu pv-menu-right pv-menu-wide">
                {(['main', 'linked'] as const)
                  .filter(login => login === 'main' || linked)
                  .map(login => (
                    <div key={login} className="pv-menu-item pv-menu-static">
                      <Avatar src={undefined} username={props.names[login]} size="sm" />
                      <span className="pv-wrap opt-grow">
                        <span className="opt-meta">{OWNER_LABEL[login]} login</span>
                        {loginNote(props, login)}
                      </span>
                    </div>
                  ))}
                <div className="pv-menu-rule" />
                {props.linkState !== 'linked' && (
                  <button className="pv-menu-item" onClick={props.onLink}>
                    {props.linkState === 'ended'
                      ? 'Link this login again'
                      : '+ Link a second login'}
                  </button>
                )}
                {linked && (
                  <button className="pv-menu-item opt-danger" onClick={props.onUnlink}>
                    Unlink linked login
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="pv-list-head">
          <span className="opt-label">
            Showing {filter === 'all' ? 'every Watch' : `${OWNER_LABEL[filter]} Watches`} (
            {shown.length})
            {filter === 'all' && tagged && (
              <span className="pv-hint">Pick a login above to filter</span>
            )}
          </span>
          {filter !== 'all' && (
            <button className="opt-btn opt-ghost pv-clear" onClick={() => setFilter('all')}>
              Show all
            </button>
          )}
        </div>
        <div className="pv-scroll">
          {shown.map(item => (
            <BadgedRow key={item.watchId} props={props} item={item} tagged={tagged} />
          ))}
        </div>
        <div className="pv-b-foot">
          <button className="opt-btn opt-primary" onClick={() => props.onGo('new')}>
            + Add Watch
          </button>
          <button
            className="pv-icon-btn"
            title="Export or import"
            onClick={() => props.onGo('transfer')}
          >
            ⇅
          </button>
          <button className="pv-status" onClick={() => setInfo(!info)} title="Schedule and storage">
            ◷ {soonest(props)}
          </button>
          {info && (
            <div className="pv-popover pv-popover-up">
              <ScheduleLines {...props} />
            </div>
          )}
        </div>
      </nav>
      {props.feed}
      {props.inspector}
    </div>
  );
}

/* ─── C: logins, schedule, and storage move to a top bar; the sidebar is only navigation ─── */

function VariantC(props: VariantProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [more, setMore] = useState(false);
  const shown = applyFilter(props.watches, filter);
  const attention = attentionOf(props.watches);
  const linked = props.linkState !== 'unlinked';
  return (
    <div className="pv-c">
      <header className="pv-topbar">
        <Logo />
        <div className="pv-logins">
          {(['main', 'linked'] as const)
            .filter(login => login === 'main' || linked)
            .map(login => (
              <span
                key={login}
                className={`pv-login-chip ${login === 'linked' && props.linkState === 'ended' ? 'pv-chip-ended' : ''}`}
              >
                <Avatar src={undefined} username={props.names[login]} size="sm" />
                <span className="opt-meta">{OWNER_LABEL[login]}</span>
                <span className="pv-wrap">{loginNote(props, login)}</span>
              </span>
            ))}
          {props.linkState !== 'linked' && (
            <button className="opt-btn" onClick={props.onLink}>
              {props.linkState === 'ended' ? 'Link again' : '+ Link a second login'}
            </button>
          )}
        </div>
        <div className="pv-topbar-right">
          <span className="opt-meta">Next check {soonest(props)}</span>
          <span
            className="pv-mini-meter"
            title={`${mib(props.storage.usedBytes)} of ${mib(props.storage.budgetBytes)} MiB`}
          >
            <Meter {...props} />
          </span>
          <button className="pv-icon-btn" onClick={() => setMore(!more)} title="More">
            ⋯
          </button>
          {more && (
            <div className="pv-popover pv-popover-right">
              <ScheduleLines {...props} />
              <button className="opt-btn" onClick={() => props.onGo('transfer')}>
                Export or import
              </button>
              {linked && (
                <button className="opt-btn opt-danger" onClick={props.onUnlink}>
                  Unlink linked login
                </button>
              )}
            </div>
          )}
        </div>
      </header>
      <div className="opt-console pv-c-body">
        <nav className="opt-list pv-col">
          <button
            className={`opt-item pv-c-nav ${props.view === 'attention' ? 'active' : ''}`}
            onClick={() => props.onGo('attention')}
          >
            <span className="opt-grow">Needs you</span>
            {attention > 0 && <span className="opt-count opt-count-error">{attention}</span>}
          </button>
          <button
            className={`opt-item pv-c-nav ${props.view === 'inbox' ? 'active' : ''}`}
            onClick={() => props.onGo('inbox')}
          >
            <span className="opt-grow">All inbox</span>
            <span className="opt-count">{inboxOf(props.watches)}</span>
          </button>
          <div className="pv-list-head">
            <span className="opt-label">Watches ({shown.length})</span>
          </div>
          <FilterTabs props={props} filter={filter} onChange={setFilter} />
          <div className="pv-scroll">
            <Rows props={props} watches={shown} />
          </div>
          <button className="opt-btn opt-primary pv-c-add" onClick={() => props.onGo('new')}>
            + Add Watch
          </button>
        </nav>
        {props.feed}
        {props.inspector}
      </div>
    </div>
  );
}

export const VARIANTS = {
  A: { name: 'Compact logins control', Component: VariantA },
  B: { name: 'Login chips filter', Component: VariantB },
  C: { name: 'Top bar', Component: VariantC },
} as const;

export type VariantKey = keyof typeof VARIANTS;
