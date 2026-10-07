/**
 * 技能发现页：仓库聚合与 skills.sh 搜索共用同一套卡片和安装动作。
 *
 * 远程请求、仓库目录解析和文件落盘都在主进程完成；这里仅管理筛选、分页和弹层状态。
 */
import { NativeSelect } from "./NativeSelect.js";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopDiscoverableSkill,
  DesktopSkillDiscoverySnapshot,
  DesktopSkillRepository,
  DesktopSkillsShDiscoverableSkill
} from "../../../protocol.js";
import { Icon } from "./Icon.js";

type DiscoverySource = "repos" | "skillssh";
type SkillStatusFilter = "all" | "installed" | "uninstalled";

const pageSize = 20;

export function SkillDiscoveryView({ onBack, onError, onInstalled }: {
  onBack(): void;
  onError(message: string): void;
  onInstalled(): Promise<void>;
}): React.JSX.Element {
  const [source, setSource] = useState<DiscoverySource>("repos");
  const [snapshot, setSnapshot] = useState<DesktopSkillDiscoverySnapshot>({ repositories: [], skills: [], warnings: [] });
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SkillStatusFilter>("all");
  const [repository, setRepository] = useState("all");
  const [loading, setLoading] = useState(true);
  const [repositoryManagerOpen, setRepositoryManagerOpen] = useState(false);
  const [installNotice, setInstallNotice] = useState<string>();
  const [installingKey, setInstallingKey] = useState<string>();
  const [skillsShInput, setSkillsShInput] = useState("");
  const [skillsShQuery, setSkillsShQuery] = useState("");
  const [skillsShSkills, setSkillsShSkills] = useState<DesktopSkillsShDiscoverableSkill[]>([]);
  const [skillsShTotal, setSkillsShTotal] = useState(0);
  const [skillsShOffset, setSkillsShOffset] = useState(0);
  const [skillsShLoading, setSkillsShLoading] = useState(false);
  const [skillsShHasSearched, setSkillsShHasSearched] = useState(false);
  const skillsShRequestRef = useRef(0);

  const loadSnapshot = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await window.biny.skillDiscovery();
      setSnapshot(next);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const visibleRepositorySkills = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return snapshot.skills.filter((skill) => {
      if (repository !== "all" && `${skill.repoOwner}/${skill.repoName}` !== repository) return false;
      if (status === "installed" && !skill.installed) return false;
      if (status === "uninstalled" && skill.installed) return false;
      if (!normalizedQuery) return true;
      return `${skill.name} ${skill.description} ${skill.directory} ${skill.repoOwner}/${skill.repoName}`.toLocaleLowerCase().includes(normalizedQuery);
    });
  }, [query, repository, snapshot.skills, status]);

  const install = useCallback(async (skill: DesktopDiscoverableSkill | DesktopSkillsShDiscoverableSkill): Promise<void> => {
    setInstallingKey(skill.key);
    setInstallNotice(undefined);
    try {
      const result = await window.biny.installDiscoveredSkill({
        key: skill.key,
        name: skill.name,
        description: "description" in skill ? skill.description : "来自 skills.sh 的技能",
        directory: skill.directory,
        readmeUrl: skill.readmeUrl,
        repoOwner: skill.repoOwner,
        repoName: skill.repoName,
        repoBranch: skill.repoBranch,
        installed: skill.installed
      });
      setInstallNotice(`${result.name} 已安装。`);
      await onInstalled();
      await loadSnapshot();
      if (source === "skillssh" && skillsShQuery) {
        setSkillsShSkills((current) => current.map((item) => item.key === skill.key ? { ...item, installed: true } : item));
      }
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setInstallingKey(undefined);
    }
  }, [loadSnapshot, onError, onInstalled, skillsShQuery, source]);

  const searchSkillsShResults = useCallback(async (nextQuery: string, offset: number, append: boolean): Promise<void> => {
    const trimmed = nextQuery.trim();
    if (trimmed.length < 2) return;
    // 请求序号防护：旧响应晚到时直接丢弃，避免覆盖更新一次搜索的结果。
    const nextRequestId = skillsShRequestRef.current + 1;
    skillsShRequestRef.current = nextRequestId;
    setSkillsShLoading(true);
    try {
      const result = await window.biny.searchSkills(trimmed, pageSize, offset);
      if (nextRequestId !== skillsShRequestRef.current) return;
      setSkillsShSkills((current) => append ? [...current, ...result.skills.filter((item) => !current.some((existing) => existing.key === item.key))] : result.skills);
      setSkillsShTotal(result.totalCount);
      setSkillsShQuery(result.query);
      setSkillsShOffset(offset);
      setSkillsShHasSearched(true);
    } catch (error) {
      if (nextRequestId === skillsShRequestRef.current) onError(errorMessage(error));
    } finally {
      if (nextRequestId === skillsShRequestRef.current) setSkillsShLoading(false);
    }
  }, [onError]);

  const handleSkillsShSearch = useCallback((): void => {
    setSkillsShOffset(0);
    void searchSkillsShResults(skillsShInput, 0, false);
  }, [searchSkillsShResults, skillsShInput]);

  const addRepository = useCallback(async (next: DesktopSkillRepository): Promise<void> => {
    try {
      const repositories = await window.biny.addSkillRepository(next);
      setSnapshot((current) => ({ ...current, repositories }));
      setRepositoryManagerOpen(false);
      await loadSnapshot();
    } catch (error) {
      onError(errorMessage(error));
    }
  }, [loadSnapshot, onError]);

  const removeRepository = useCallback(async (next: DesktopSkillRepository): Promise<void> => {
    try {
      const repositories = await window.biny.removeSkillRepository(next.owner, next.name);
      setSnapshot((current) => ({ ...current, repositories, skills: current.skills.filter((skill) => skill.repoOwner !== next.owner || skill.repoName !== next.name) }));
    } catch (error) {
      onError(errorMessage(error));
    }
  }, [onError]);

  return (
    <div className="biny-skill-discovery-page">
      <header className="biny-skill-discovery-header">
        <button aria-label="返回技能管理" className="biny-skill-discovery-back" onClick={onBack} type="button"><Icon name="arrow-left" size={18} /></button>
        <h1>Skills 管理</h1>
        <div className="biny-skill-discovery-header-actions">
          <button disabled={loading} onClick={() => void loadSnapshot()} type="button"><Icon name="refresh" size={16} />刷新</button>
          <button onClick={() => setRepositoryManagerOpen(true)} type="button"><Icon name="settings" size={16} />仓库管理</button>
        </div>
      </header>
      <div className="biny-skill-discovery-body">
        {installNotice ? <p className="biny-extension-warning" role="status">{installNotice}</p> : null}
        {snapshot.warnings.length ? <div className="biny-extension-warning" role="status"><Icon name="warning" size={15} /><div>{snapshot.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div></div> : null}
        <div className="biny-skill-discovery-source-tabs" role="tablist" aria-label="技能发现来源">
          <button aria-selected={source === "repos"} className={source === "repos" ? "is-active" : ""} onClick={() => setSource("repos")} role="tab" type="button">仓库</button>
          <button aria-selected={source === "skillssh"} className={source === "skillssh" ? "is-active" : ""} onClick={() => setSource("skillssh")} role="tab" type="button">skills.sh</button>
        </div>
        {source === "repos" ? (
          <>
            <DiscoveryFilters query={query} repository={repository} repositories={snapshot.repositories} status={status} onQuery={setQuery} onRepository={setRepository} onStatus={setStatus} />
            {loading && !snapshot.skills.length ? <DiscoveryLoading /> : !visibleRepositorySkills.length ? <DiscoveryEmpty detail="没有匹配的技能，试试其他搜索词或仓库。" /> : <div className="biny-discovery-grid">{visibleRepositorySkills.map((skill) => <DiscoveryCard key={skill.key} skill={skill} installing={installingKey === skill.key} onInstall={() => void install(skill)} onView={() => void openUrl(skill.readmeUrl, onError)} />)}</div>}
          </>
        ) : (
          <SkillsShPanel
            hasSearched={skillsShHasSearched}
            input={skillsShInput}
            loading={skillsShLoading}
            skills={skillsShSkills}
            total={skillsShTotal}
            onInput={setSkillsShInput}
            onLoadMore={() => void searchSkillsShResults(skillsShQuery, skillsShOffset + pageSize, true)}
            onSearch={handleSkillsShSearch}
            installingKey={installingKey}
            onInstall={(skill) => void install(skill)}
            onView={(url) => void openUrl(url, onError)}
          />
        )}
      </div>
      {repositoryManagerOpen ? <RepositoryManager repositories={snapshot.repositories} onAdd={(repository) => void addRepository(repository)} onClose={() => setRepositoryManagerOpen(false)} onRemove={(repository) => void removeRepository(repository)} /> : null}
    </div>
  );
}

const DiscoveryFilters = memo(function DiscoveryFilters({ query, repository, repositories, status, onQuery, onRepository, onStatus }: {
  query: string;
  repository: string;
  repositories: DesktopSkillRepository[];
  status: SkillStatusFilter;
  onQuery(query: string): void;
  onRepository(repository: string): void;
  onStatus(status: SkillStatusFilter): void;
}): React.JSX.Element {
  return (
    <div className="biny-discovery-filters">
      <label className="biny-discovery-search"><Icon name="search" size={17} /><input aria-label="搜索技能名称或仓库名称" onChange={(event) => onQuery(event.target.value)} placeholder="搜索技能名称或仓库名称…" value={query} /></label>
      <NativeSelect aria-label="筛选仓库" onChange={(event) => onRepository(event.target.value)} value={repository}>
        <option value="all">全部仓库</option>
        {repositories.map((item) => <option key={`${item.owner}/${item.name}`} value={`${item.owner}/${item.name}`}>{item.owner}/{item.name}</option>)}
      </NativeSelect>
      <NativeSelect aria-label="筛选安装状态" onChange={(event) => onStatus(event.target.value as SkillStatusFilter)} value={status}>
        <option value="all">全部</option>
        <option value="installed">已安装</option>
        <option value="uninstalled">未安装</option>
      </NativeSelect>
    </div>
  );
});

export const DiscoveryCard = memo(function DiscoveryCard({ skill, installing, onInstall, onView }: {
  skill: DesktopDiscoverableSkill;
  installing: boolean;
  onInstall(): void;
  onView(): void;
}): React.JSX.Element {
  return (
    <article className="biny-discovery-card">
      <div className="biny-discovery-card-content">
        <h2>{skill.name}</h2>
        <div className="biny-discovery-card-repo">{skill.directory === "." ? "仓库根目录（.）" : skill.directory}<span>{skill.repoOwner}/{skill.repoName}</span></div>
        <p>{skill.description}</p>
      </div>
      <div className="biny-discovery-card-actions">
        <button className="biny-discovery-view" onClick={onView} type="button"><Icon name="external" size={15} />查看</button>
        <button aria-label={`${skill.installed ? "已安装" : installing ? "安装中" : "安装"} ${skill.name}（${skill.directory === "." ? "仓库根目录：." : skill.directory}）`} className="biny-discovery-install" disabled={skill.installed || installing} onClick={onInstall} type="button">{skill.installed ? <><Icon name="check" size={15} />已安装</> : installing ? "安装中…" : <><Icon name="archive" size={15} />安装</>}</button>
      </div>
    </article>
  );
});

const SkillsShPanel = memo(function SkillsShPanel({ hasSearched, input, loading, skills, total, onInput, onLoadMore, onSearch, installingKey, onInstall, onView }: {
  hasSearched: boolean;
  input: string;
  loading: boolean;
  skills: DesktopSkillsShDiscoverableSkill[];
  total: number;
  onInput(input: string): void;
  onLoadMore(): void;
  onSearch(): void;
  installingKey?: string;
  onInstall(skill: DesktopSkillsShDiscoverableSkill): void;
  onView(url?: string): void;
}): React.JSX.Element {
  return (
    <>
      <div className="biny-skillssh-search-row">
        <label className="biny-discovery-search"><Icon name="search" size={17} /><input aria-label="搜索 skills.sh" onChange={(event) => onInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} placeholder="搜索 skills.sh 技能…" value={input} /></label>
        <button className="biny-discovery-search-button" disabled={input.trim().length < 2 || loading} onClick={onSearch} type="button">{loading ? "搜索中…" : "搜索"}</button>
      </div>
      {!hasSearched ? <DiscoveryEmpty detail="输入至少 2 个字符，搜索 skills.sh 公共技能目录。" /> : !skills.length && !loading ? <DiscoveryEmpty detail="没有找到匹配的 skills.sh 技能。" /> : <>
        <div className="biny-discovery-result-meta">共找到 {total} 个结果</div>
        <div className="biny-discovery-grid">{skills.map((skill) => <SkillsShCard key={skill.key} skill={skill} installing={installingKey === skill.key} onInstall={() => onInstall(skill)} onView={() => onView(skill.readmeUrl)} />)}</div>
        {skills.length < total ? <button className="biny-discovery-load-more" disabled={loading} onClick={onLoadMore} type="button">{loading ? "加载中…" : "加载更多"}</button> : null}
      </>}
    </>
  );
});

export const SkillsShCard = memo(function SkillsShCard({ skill, installing, onInstall, onView }: {
  skill: DesktopSkillsShDiscoverableSkill;
  installing: boolean;
  onInstall(): void;
  onView(): void;
}): React.JSX.Element {
  return (
    <article className="biny-discovery-card">
      <div className="biny-discovery-card-content">
        <h2>{skill.name}</h2>
        <div className="biny-discovery-card-repo">{skill.directory === "." ? "仓库根目录（.）" : skill.directory}<span>{skill.repoOwner}/{skill.repoName}</span></div>
        <p>来自 skills.sh，已安装 {skill.installs.toLocaleString()} 次。</p>
      </div>
      <div className="biny-discovery-card-actions">
        <button className="biny-discovery-view" onClick={onView} type="button"><Icon name="external" size={15} />查看</button>
        <button aria-label={`${skill.installed ? "已安装" : installing ? "安装中" : "安装"} ${skill.name}（${skill.directory === "." ? "仓库根目录：." : skill.directory}）`} className="biny-discovery-install" disabled={skill.installed || installing} onClick={onInstall} type="button">{skill.installed ? <><Icon name="check" size={15} />已安装</> : installing ? "安装中…" : <><Icon name="archive" size={15} />安装</>}</button>
      </div>
    </article>
  );
});

const RepositoryManager = memo(function RepositoryManager({ repositories, onAdd, onClose, onRemove }: {
  repositories: DesktopSkillRepository[];
  onAdd(repository: DesktopSkillRepository): void;
  onClose(): void;
  onRemove(repository: DesktopSkillRepository): void;
}): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [error, setError] = useState<string>();

  const submit = (): void => {
    const parsed = parseRepository(url, branch);
    if (!parsed) {
      setError("请输入 owner/repository 或 GitHub 仓库地址。");
      return;
    }
    setError(undefined);
    onAdd(parsed);
    setUrl("");
  };

  return (
    <div className="biny-skill-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-label="仓库管理" className="biny-skill-repository-dialog" role="dialog">
        <div className="biny-skill-dialog-heading"><div><h2>仓库管理</h2><p>添加 GitHub 仓库，发现其中的 SKILL.md。</p></div><button aria-label="关闭仓库管理" onClick={onClose} type="button"><Icon name="close" size={18} /></button></div>
        <div className="biny-skill-repository-form">
          <input aria-label="GitHub 仓库" onChange={(event) => setUrl(event.target.value)} placeholder="owner/repository 或 GitHub URL" value={url} />
          <input aria-label="仓库分支" onChange={(event) => setBranch(event.target.value)} placeholder="分支" value={branch} />
          <button onClick={submit} type="button"><Icon name="add" size={15} />添加仓库</button>
        </div>
        {error ? <div className="biny-skill-dialog-error" role="alert">{error}</div> : null}
        <div className="biny-skill-repository-list">
          {repositories.map((repository) => <div className="biny-skill-repository-row" key={`${repository.owner}/${repository.name}`}><div><strong>{repository.owner}/{repository.name}</strong><span>{repository.branch}</span></div><button aria-label={`删除 ${repository.owner}/${repository.name}`} onClick={() => onRemove(repository)} type="button"><Icon name="trash" size={15} /></button></div>)}
        </div>
      </section>
    </div>
  );
});

function DiscoveryLoading(): React.JSX.Element {
  return <div className="biny-discovery-placeholder">正在从仓库读取技能…</div>;
}

function DiscoveryEmpty({ detail }: { detail: string }): React.JSX.Element {
  return <div className="biny-discovery-placeholder"><Icon name="wand" size={24} /><strong>暂无技能</strong><span>{detail}</span></div>;
}

function parseRepository(value: string, branch: string): DesktopSkillRepository | undefined {
  const normalized = value.trim().replace(/^https?:\/\/(?:www\.)?github\.com\//u, "").replace(/\.git$/u, "").replace(/\/$/u, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length !== 2 || !/^[A-Za-z0-9-]{1,39}$/u.test(parts[0] ?? "") || !/^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u.test(parts[1] ?? "") || !branch.trim()) return undefined;
  return { owner: parts[0]!, name: parts[1]!, branch: branch.trim(), enabled: true };
}

async function openUrl(url: string | undefined, onError: (message: string) => void): Promise<void> {
  if (!url) return;
  try {
    await window.biny.openExternal(url);
  } catch (error) {
    onError(errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
