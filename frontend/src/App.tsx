import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconArrowsExchange, IconBraces, IconCheck, IconChevronDown, IconChevronUp, IconLayersDifference, IconLockCheck, IconLogout, IconMoon, IconServerOff, IconSun } from '@tabler/icons-react'
import { ActionIcon, Anchor, AppShell, Badge, Box, Burger, Button, Card, Code, Collapse, Combobox, Container, Fieldset, Grid, Group, Input, InputBase, Loader, NavLink, SegmentedControl, Skeleton, Stack, Table, Text, TextInput, Title, Tooltip, UnstyledButton, useCombobox, useMantineColorScheme } from '@mantine/core'
import { CheckResult, checkResultErrorProps, type ExpandTreeNode } from './CheckResult'


type Page = 'schema' | 'relations' | 'check'
type CheckMode = 'check' | 'lookup' | 'subject'

const CHECK_MODES: { mode: CheckMode; label: string }[] = [
  { mode: 'check', label: 'Resource check' },
  { mode: 'lookup', label: 'Entity lookup' },
  { mode: 'subject', label: 'Subject lookup' },
]

const V = 'v1'

interface SchemaVersion {
  version: string
  created_at: string
}

interface PermChild {
  leaf?: {
    computed_user_set?: { relation: string }
    tuple_to_user_set?: { tupleSet: { relation: string }; computed: { relation: string } }
  }
  rewrite?: { rewrite_operation: string; children: PermChild[] }
}

interface EntityDef {
  name: string
  relations: Record<string, { name: string; relation_references: { type: string; relation: string }[] }>
  permissions: Record<string, { name: string; child: PermChild }>
}

interface SchemaDiffLine {
  kind: 'added' | 'removed'
  text: string
}

interface SchemaDiffBlock {
  key: string
  title: string
  kind: 'added' | 'removed' | 'changed'
  lines: SchemaDiffLine[]
}

interface TupleRecord {
  entity: { type: string; id: string }
  relation: string
  subject: { type: string; id: string; relation: string }
}

interface CheckResult {
  can: 'CHECK_RESULT_ALLOWED' | 'CHECK_RESULT_DENIED'
  metadata: { check_count: number }
}

interface LookupEntityResult {
  entityIds: string[]
  continuousToken: string
}

interface LookupSubjectResult {
  subjectIds: string[]
  continuousToken: string
}

interface ApiClient {
  listSchemas(): Promise<{ head: string; schemas: SchemaVersion[] }>
  readSchema(version: string): Promise<EntityDef[]>
  readRelationships(filter: {
    snapToken: string
    entityType: string
    entityIds: string[]
    relation: string
    subjectType: string
    subjectIds: string[]
    pageSize?: number
    continuousToken?: string
  }): Promise<{ tuples: TupleRecord[]; continuousToken: string }>
  checkPermission(params: {
    entityType: string
    entityId: string
    permission: string
    subjectType: string
    subjectId: string
    subjectRelation?: string
    snapToken: string
  }): Promise<CheckResult>
  lookupEntity(params: {
    entityType: string
    permission: string
    subjectType: string
    subjectId: string
    snapToken: string
    continuousToken?: string
  }): Promise<LookupEntityResult>
  lookupSubject(params: {
    entityType: string
    entityId: string
    permission: string
    subjectType: string
    subjectRelation?: string
    snapToken: string
    continuousToken?: string
  }): Promise<LookupSubjectResult>
  expandPermission(params: {
    entityType: string
    entityId: string
    permission: string
    snapToken: string
  }): Promise<ExpandTreeNode>
}

function schemaCreatedAtTimestamp(value: string): number {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (!match) return 0

  const [, year, month, day, hour, minute, second] = match
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
}

function sortSchemaVersions(schemas: SchemaVersion[], head: string): SchemaVersion[] {
  return [...schemas].sort((a, b) => {
    if (a.version === head) return -1
    if (b.version === head) return 1

    const timeDiff = schemaCreatedAtTimestamp(b.created_at) - schemaCreatedAtTimestamp(a.created_at)
    if (timeDiff !== 0) return timeDiff

    return b.version.localeCompare(a.version)
  })
}

class ConnectionError extends Error {
  constructor() {
    super('Cannot connect to Permify')
  }
}

export class ApiError extends Error {
  constructor(public readonly path: string, public readonly status: number, message: string, public readonly body?: unknown) {
    super(message)
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new ApiError(path, res.status, `HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (res.status === 502 || res.status === 503) throw new ConnectionError()

  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    let errorBody: unknown

    try {
      errorBody = await res.json()
      if ((errorBody as { message?: string }).message) msg = (errorBody as { message: string }).message
    } catch {
      // ignore malformed error payloads
    }

    throw new ApiError(path, res.status, msg, errorBody)
  }

  return res.json() as Promise<T>
}

function tenantPath(tenant: string, path: string) {
  return `/${V}/tenants/${tenant}${path}`
}

function getAppConfig() {
  return getJson<{ enabled: boolean; provider: string; permify_url: string; tenant: string }>('/auth/config')
}

function getCurrentUser() {
  return getJson<{ email: string }>('/auth/me')
}

async function ping() {
  const res = await fetch('/internal/ping')
  if (!res.ok) throw new ConnectionError()
}

function createApiClient(tenant: string): ApiClient {
  return {
    async listSchemas() {
      const data = await postJson<{ head: string; schemas?: SchemaVersion[] }>(tenantPath(tenant, '/schemas/list'), {
        page_size: 50,
        continuous_token: '',
      })
      return { head: data.head, schemas: sortSchemaVersions(data.schemas ?? [], data.head) }
    },

    async readSchema(version: string) {
      const data = await postJson<{ schema: { entity_definitions: Record<string, EntityDef> } }>(tenantPath(tenant, '/schemas/read'), {
        metadata: { schema_version: version },
      })
      return Object.values(data.schema.entity_definitions)
    },

    async readRelationships(filter) {
      const body: Record<string, unknown> = {
        metadata: { snap_token: filter.snapToken },
        filter: {
          entity: { type: filter.entityType, ids: filter.entityIds },
          relation: filter.relation,
          subject: { type: filter.subjectType, ids: filter.subjectIds, relation: '' },
        },
        continuous_token: filter.continuousToken ?? '',
      }

      if (filter.pageSize) body.page_size = filter.pageSize

      const data = await postJson<{ tuples?: TupleRecord[]; continuous_token?: string }>(tenantPath(tenant, '/data/relationships/read'), body)
      return { tuples: data.tuples ?? [], continuousToken: data.continuous_token ?? '' }
    },

    checkPermission(params) {
      return postJson<CheckResult>(tenantPath(tenant, '/permissions/check'), {
        metadata: { snap_token: params.snapToken, schema_version: '', depth: 20 },
        entity: { type: params.entityType, id: params.entityId },
        permission: params.permission,
        subject: { type: params.subjectType, id: params.subjectId, relation: params.subjectRelation ?? '' },
      })
    },

    lookupEntity(params) {
      return postJson<{ entity_ids?: string[]; continuous_token?: string }>(tenantPath(tenant, '/permissions/lookup-entity'), {
        metadata: { snap_token: params.snapToken, schema_version: '', depth: 20 },
        entity_type: params.entityType,
        permission: params.permission,
        subject: { type: params.subjectType, id: params.subjectId, relation: '' },
        page_size: 100,
        continuous_token: params.continuousToken ?? '',
      })
        .then((data) => ({ entityIds: data.entity_ids ?? [], continuousToken: data.continuous_token ?? '' }))
    },

    lookupSubject(params) {
      return postJson<{ subject_ids?: string[]; continuous_token?: string }>(tenantPath(tenant, '/permissions/lookup-subject'), {
        metadata: { snap_token: params.snapToken, schema_version: '', depth: 20 },
        entity: { type: params.entityType, id: params.entityId },
        permission: params.permission,
        subject_reference: { type: params.subjectType, relation: params.subjectRelation ?? '' },
        continuous_token: params.continuousToken ?? '',
      })
        .then((data) => ({ subjectIds: data.subject_ids ?? [], continuousToken: data.continuous_token ?? '' }))
    },

    async expandPermission(params) {
      const data = await postJson<{ tree: ExpandTreeNode }>(tenantPath(tenant, '/permissions/expand'), {
        metadata: { snap_token: params.snapToken, schema_version: '' },
        entity: { type: params.entityType, id: params.entityId },
        permission: params.permission,
      })
      return data.tree
    },
  }
}

function parsePage(value: string | null): Page {
  if (value === 'relations' || value === 'check') return value
  return 'schema'
}

function parseCheckMode(value: string | null): CheckMode {
  if (value === 'lookup' || value === 'subject') return value
  return 'check'
}

function readLocationState(): { page: Page; checkMode: CheckMode } {
  const params = new URLSearchParams(window.location.search)
  const page = parsePage(params.get('page'))
  return { page, checkMode: page === 'check' ? parseCheckMode(params.get('mode')) : 'check' }
}

function checkAccessUrl(mode: CheckMode) {
  return mode === 'check' ? '/?page=check' : `/?page=check&mode=${mode}`
}

const footerActionIconStyles = { root: { color: 'var(--mantine-color-dimmed)' } }

function ThemeSchemeIcon() {
  const { colorScheme, setColorScheme } = useMantineColorScheme()
  const activeColorScheme = colorScheme === 'dark' ? 'dark' : 'light'
  const label = activeColorScheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
  const Icon = activeColorScheme === 'dark' ? IconSun : IconMoon

  return (
    <Tooltip label={label} position="top">
      <ActionIcon
        variant="subtle"
        size="sm"
        aria-label={label}
        onClick={() => setColorScheme(activeColorScheme === 'dark' ? 'light' : 'dark')}
        styles={footerActionIconStyles}
      >
        <Icon size={16} />
      </ActionIcon>
    </Tooltip>
  )
}

function LogoutControl() {
  return (
    <Tooltip label="Logout" position="top">
      <Box component="form" action="/auth/logout" method="post">
        <ActionIcon
          type="submit"
          variant="subtle"
          size="sm"
          aria-label="Logout"
          styles={footerActionIconStyles}
        >
          <IconLogout size={16} />
        </ActionIcon>
      </Box>
    </Tooltip>
  )
}

function NavbarFooter({ authEnabled, email }: { authEnabled: boolean; email: string }) {
  if (!authEnabled) return null

  return (
    <AppShell.Section px="lg" py="md" mt="md">
      <Group gap="xs" wrap="nowrap">
        <Text size="xs" c="dimmed" truncate="end" style={{ flex: 1, minWidth: 0 }}>
          {email}
        </Text>
        <LogoutControl />
      </Group>
    </AppShell.Section>
  )
}

function ConnectionScreen({ permifyUrl, onRetry }: { permifyUrl: string; onRetry: () => void }) {
  return (
    <Stack align="center" justify="center" h="100vh" bg="var(--mantine-color-body)">
      <Container size={400} w="100%">
        <Card withBorder p="xl">
          <Stack align="center" gap="md">
            <IconServerOff size={48} color="var(--mantine-color-red-6)" />
            <Title order={3}>Cannot connect to Permify</Title>
            <Text size="sm" c="dimmed" ta="center">
              The server at <Code>{permifyUrl}</Code> is not responding.
              Check that Permify is running and <Code>permify_url</Code> in config.yaml is correct.
            </Text>
            <Button onClick={onRetry} fullWidth>
              Retry
            </Button>
          </Stack>
        </Card>
      </Container>
    </Stack>
  )
}

function LoginScreen({ provider }: { provider: string }) {
  return (
    <Stack align="center" justify="center" h="100vh" bg="var(--mantine-color-body)">
      <Container size={340} w="100%">
        <Card withBorder p="xl">
          <Stack align="center">
            <Title order={2}>Permify UI</Title>
            <Button component="a" href="/auth/login" fullWidth>
              Sign in with {provider}
            </Button>
          </Stack>
        </Card>
      </Container>
    </Stack>
  )
}

function formulaToSchema(child: PermChild, parentOp?: string): string {
  if (child.leaf) {
    if (child.leaf.computed_user_set) return child.leaf.computed_user_set.relation
    if (child.leaf.tuple_to_user_set) {
      const tupleSet = child.leaf.tuple_to_user_set
      return `${tupleSet.tupleSet.relation}.${tupleSet.computed.relation}`
    }
    return '?'
  }

  if (child.rewrite) {
    const op = rewriteOperator(child.rewrite.rewrite_operation)
    const inner = child.rewrite.children
      .map((nestedChild) => formulaToSchema(nestedChild, child.rewrite!.rewrite_operation))
      .join(op)

    return parentOp && parentOp !== child.rewrite.rewrite_operation ? `(${inner})` : inner
  }

  return '?'
}

function rewriteOperator(operation: string): string {
  switch (operation) {
    case 'OPERATION_UNION':
      return ' or '
    case 'OPERATION_INTERSECTION':
      return ' and '
    case 'OPERATION_EXCLUSION':
      return ' not '
    default:
      return ' and '
  }
}

function generateSchemaText(entities: EntityDef[]): string {
  return entities.map((entity) => {
    const lines: string[] = []

    for (const relation of Object.values(entity.relations)) {
      const refs = (relation.relation_references ?? []).map((ref) => `@${ref.type}${ref.relation ? `#${ref.relation}` : ''}`).join(' | ')
      lines.push(`    relation ${relation.name}${refs ? ` ${refs}` : ''}`)
    }

    for (const permission of Object.values(entity.permissions)) {
      lines.push(`    permission ${permission.name} = ${formulaToSchema(permission.child)}`)
    }

    return [`entity ${entity.name} {`, ...lines, '}'].join('\n')
  }).join('\n\n')
}

function formatRelationDefinition(relation: EntityDef['relations'][string]): string {
  const refs = (relation.relation_references ?? []).map((ref) => `@${ref.type}${ref.relation ? `#${ref.relation}` : ''}`).join(' | ')
  return `relation ${relation.name}${refs ? ` ${refs}` : ''}`
}

function formatPermissionDefinition(permission: EntityDef['permissions'][string]): string {
  return `permission ${permission.name} = ${formulaToSchema(permission.child)}`
}

function sortByName<T extends { name: string }>(values: T[]): T[] {
  return [...values].sort((a, b) => a.name.localeCompare(b.name))
}

function diffNamedDefinitions<T extends { name: string }>(
  previous: Record<string, T>,
  latest: Record<string, T>,
  formatDefinition: (value: T) => string,
): SchemaDiffLine[] {
  const names = [...new Set([...Object.keys(previous), ...Object.keys(latest)])].sort()
  const lines: SchemaDiffLine[] = []

  names.forEach((name) => {
    const previousValue = previous[name]
    const latestValue = latest[name]

    if (!previousValue && latestValue) {
      lines.push({ kind: 'added', text: formatDefinition(latestValue) })
      return
    }

    if (previousValue && !latestValue) {
      lines.push({ kind: 'removed', text: formatDefinition(previousValue) })
      return
    }

    if (previousValue && latestValue) {
      const previousLine = formatDefinition(previousValue)
      const latestLine = formatDefinition(latestValue)

      if (previousLine !== latestLine) {
        lines.push({ kind: 'removed', text: previousLine })
        lines.push({ kind: 'added', text: latestLine })
      }
    }
  })

  return lines
}

function diffSchemas(previousEntities: EntityDef[], latestEntities: EntityDef[]): SchemaDiffBlock[] {
  const previousByName = Object.fromEntries(previousEntities.map((entity) => [entity.name, entity]))
  const latestByName = Object.fromEntries(latestEntities.map((entity) => [entity.name, entity]))
  const entityNames = [...new Set([...Object.keys(previousByName), ...Object.keys(latestByName)])].sort()
  const blocks: SchemaDiffBlock[] = []

  entityNames.forEach((entityName) => {
    const previousEntity = previousByName[entityName]
    const latestEntity = latestByName[entityName]

    if (!previousEntity && latestEntity) {
      blocks.push({
        key: `added:${entityName}`,
        title: `+ entity ${entityName}`,
        kind: 'added',
        lines: [
          ...sortByName(Object.values(latestEntity.relations)).map((relation) => ({ kind: 'added' as const, text: formatRelationDefinition(relation) })),
          ...sortByName(Object.values(latestEntity.permissions)).map((permission) => ({ kind: 'added' as const, text: formatPermissionDefinition(permission) })),
        ],
      })
      return
    }

    if (previousEntity && !latestEntity) {
      blocks.push({
        key: `removed:${entityName}`,
        title: `- entity ${entityName}`,
        kind: 'removed',
        lines: [
          ...sortByName(Object.values(previousEntity.relations)).map((relation) => ({ kind: 'removed' as const, text: formatRelationDefinition(relation) })),
          ...sortByName(Object.values(previousEntity.permissions)).map((permission) => ({ kind: 'removed' as const, text: formatPermissionDefinition(permission) })),
        ],
      })
      return
    }

    if (!previousEntity || !latestEntity) {
      return
    }

    const lines = [
      ...diffNamedDefinitions(previousEntity.relations, latestEntity.relations, formatRelationDefinition),
      ...diffNamedDefinitions(previousEntity.permissions, latestEntity.permissions, formatPermissionDefinition),
    ]

    if (lines.length === 0) {
      return
    }

    blocks.push({
      key: `changed:${entityName}`,
      title: `entity ${entityName}`,
      kind: 'changed',
      lines,
    })
  })

  return blocks
}

const SCHEMA_TOKEN_RE = /(\b(?:entity|relation|permission)\b)|(\b(?:or|and|not)\b)|(@\w+)|([{}=|])|([^\s{}=|@]+|\s+)/g

function keywordColor(token: string): string {
  if (token === 'entity') return 'var(--syntax-entity-keyword)'
  if (token === 'relation') return 'var(--syntax-relation-keyword)'
  return 'var(--syntax-permission-keyword)'
}

function SchemaToken({ color, children }: { color: string; children: ReactNode }) {
  return <Text component="span" inherit c={color}>{children}</Text>
}

function tokenizeLine(line: string): ReactNode {
  if (!line.trim()) return '\u00a0'

  const parts: ReactNode[] = []
  let match: RegExpExecArray | null
  let key = 0
  SCHEMA_TOKEN_RE.lastIndex = 0

  while ((match = SCHEMA_TOKEN_RE.exec(line)) !== null) {
    if (match[1]) parts.push(<SchemaToken key={key++} color={keywordColor(match[1])}>{match[1]}</SchemaToken>)
    else if (match[2]) parts.push(<SchemaToken key={key++} color="var(--syntax-operator-keyword)">{match[2]}</SchemaToken>)
    else if (match[3]) parts.push(<SchemaToken key={key++} color="var(--syntax-reference-type)">{match[3]}</SchemaToken>)
    else if (match[4]) parts.push(<SchemaToken key={key++} color="var(--syntax-punct)">{match[4]}</SchemaToken>)
    else parts.push(match[5])
  }

  return parts
}

function SchemaCodeSurface({ children }: { children: ReactNode }) {
  return (
    <Box
      component="pre"
      mt="xs"
      mb={0}
      ml={0}
      mr={0}
      ff="monospace"
      fz="xs"
      style={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflow: 'auto',
      }}
    >
      {children}
    </Box>
  )
}

function SchemaHighlight({ code }: { code: string }) {
  const lines = code.split('\n')

  return (
    <SchemaCodeSurface>
      {lines.map((line, lineIndex) => (
        <Box key={lineIndex} component="span" display="block">
          {tokenizeLine(line)}
        </Box>
      ))}
    </SchemaCodeSurface>
  )
}

function SchemaDiffView({ blocks, emptyLabel }: { blocks: SchemaDiffBlock[]; emptyLabel: string }) {
  if (blocks.length === 0) {
    return <Text size="sm" c="dimmed">{emptyLabel}</Text>
  }

  return (
    <SchemaCodeSurface>
      <Stack gap="xl">
        {blocks.map((block) => {
          const titleColor =
            block.kind === 'added'
              ? 'var(--schema-diff-added)'
              : block.kind === 'removed'
                ? 'var(--schema-diff-removed)'
                : undefined

          return (
            <Stack key={block.key} gap="xs">
              <Text
                ff="monospace"
                fz="xs"
                c={titleColor}
                style={{ overflowWrap: 'anywhere' }}
              >
                {block.title}
              </Text>
              <Stack gap={4} pl="sm">
                {block.lines.map((line, index) => (
                  <Text
                    key={`${block.key}:${index}`}
                    ff="monospace"
                    fz="xs"
                    c={line.kind === 'added' ? 'var(--schema-diff-added)' : 'var(--schema-diff-removed)'}
                    style={{ overflowWrap: 'anywhere' }}
                  >
                    {line.kind === 'added' ? '+' : '-'} {line.text}
                  </Text>
                ))}
              </Stack>
            </Stack>
          )
        })}
      </Stack>
    </SchemaCodeSurface>
  )
}

const PAGE_MAX_WIDTH = 880
const RELATIONS_PAGE_MAX_WIDTH = 1040

function PageShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <Box
      maw={wide ? RELATIONS_PAGE_MAX_WIDTH : PAGE_MAX_WIDTH}
      px={{ base: 'md', sm: 'xl' }}
      py={{ base: 'md', sm: 'xl' }}
    >
      {children}
    </Box>
  )
}

function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <Group justify="space-between" align="flex-start" wrap="nowrap" w="100%">
      <Stack gap={4} style={{ minWidth: 0 }}>
        <Title order={4}>{title}</Title>
        {description && <Text size="sm" c="dimmed">{description}</Text>}
      </Stack>
      <ThemeSchemeIcon />
    </Group>
  )
}

function fmtDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/)
  if (!match) return value

  const [, year, month, day, hour, minute] = match
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const monthIndex = Number(month) - 1
  const monthLabel = months[monthIndex]

  if (!monthLabel) return value

  return `${Number(day)} ${monthLabel} ${year}, ${hour}:${minute}`
}

function SchemaScreen({ api }: { api: ApiClient }) {
  const [schemas, setSchemas] = useState<SchemaVersion[]>([])
  const [selected, setSelected] = useState('')
  const [entities, setEntities] = useState<EntityDef[]>([])
  const [loading, setLoading] = useState(true)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareBlocks, setCompareBlocks] = useState<SchemaDiffBlock[] | null>(null)
  const [compareError, setCompareError] = useState<Error | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const schemaCacheRef = useRef<Record<string, EntityDef[]>>({})
  const schemaLoadRequestRef = useRef(0)
  const combobox = useCombobox()

  async function readSchema(version: string) {
    const cached = schemaCacheRef.current[version]
    if (cached) {
      return cached
    }

    const next = await api.readSchema(version)
    schemaCacheRef.current[version] = next
    return next
  }

  async function loadSchema(version: string) {
    const requestId = ++schemaLoadRequestRef.current
    setSchemaLoading(true)
    setError(null)
    setCompareBlocks(null)
    setCompareError(null)
    try {
      const nextEntities = await readSchema(version)
      if (requestId !== schemaLoadRequestRef.current) {
        return
      }

      setEntities(nextEntities)
    } catch (err: unknown) {
      if (requestId !== schemaLoadRequestRef.current) {
        return
      }

      setError(err instanceof Error ? err : new Error('unknown error'))
    } finally {
      if (requestId === schemaLoadRequestRef.current) {
        setSchemaLoading(false)
      }
    }
  }

  useEffect(() => {
    api.listSchemas()
      .then((data) => {
        setSchemas(data.schemas)
        if (data.head) {
          setSelected(data.head)
          loadSchema(data.head)
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err : new Error('unknown error')))
      .finally(() => setLoading(false))
  }, [api])

  if (loading) {
    return (
      <PageShell>
        <Stack gap="xl">
          <Skeleton h={26} w={120} />
          <Skeleton h={60} />
          <Stack gap="sm">
            <Skeleton h={20} w={100} />
            <Skeleton h={360} />
          </Stack>
        </Stack>
      </PageShell>
    )
  }
  if (error) {
    return (
      <PageShell>
        <Stack gap="xl">
          <PageHeader title="Schemas" />
          <CheckResult {...checkResultErrorProps(error)} />
        </Stack>
      </PageShell>
    )
  }

  const selectedSchema = schemas.find((schema) => schema.version === selected)
  const selectedIndex = schemas.findIndex((schema) => schema.version === selected)
  const previousSchema = selectedIndex >= 0 ? schemas[selectedIndex + 1] : undefined
  const canCompare = Boolean(previousSchema)

  async function toggleCompare() {
    if (compareBlocks) {
      setCompareBlocks(null)
      setCompareError(null)
      return
    }

    if (!canCompare) {
      return
    }

    setCompareLoading(true)
    setCompareError(null)

    try {
      if (!previousSchema) {
        return
      }

      const previousEntities = await readSchema(previousSchema.version)
      setCompareBlocks(diffSchemas(previousEntities, entities))
    } catch (err: unknown) {
      setCompareError(err instanceof Error ? err : new Error('unknown error'))
    } finally {
      setCompareLoading(false)
    }
  }

  return (
    <PageShell>
      <Stack gap="xl">
        <PageHeader title="Schemas" />
        <Group align="flex-end" gap="sm" wrap="wrap">
          <Box style={{ flex: 1, minWidth: 0, maxWidth: 540 }}>
            <Combobox
              store={combobox}
              onOptionSubmit={(value) => {
                if (value !== selected) {
                  setSelected(value)
                  loadSchema(value)
                }
                combobox.closeDropdown()
              }}
              position="bottom-start"
              shadow="md"
              width="target"
            >
              <Combobox.Target targetType="button">
                <InputBase
                  label="Version"
                  component="button"
                  type="button"
                  pointer
                  w="100%"
                  rightSection={<Combobox.Chevron />}
                  rightSectionPointerEvents="none"
                  onClick={() => combobox.toggleDropdown()}
                >
                  <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={500} component="span" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {selected}
                    </Text>
                    {selectedSchema?.created_at && (
                      <Text size="xs" c="dimmed" component="span" style={{ whiteSpace: 'nowrap' }}>
                        {fmtDate(selectedSchema.created_at)}
                      </Text>
                    )}
                  </Group>
                </InputBase>
              </Combobox.Target>
              <Combobox.Dropdown>
                <Combobox.Options mah={260} style={{ overflowY: 'auto' }}>
                  {schemas.map((schema) => (
                    <Combobox.Option
                      key={schema.version}
                      value={schema.version}
                      active={schema.version === selected}
                    >
                      <Group justify="space-between" wrap="nowrap" gap="sm" style={{ flex: 1, minWidth: 0 }}>
                        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                          <Text size="sm" fw={schema.version === selected ? 500 : 400} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {schema.version}
                          </Text>
                          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                            {fmtDate(schema.created_at)}
                          </Text>
                        </Group>
                        {schema.version === selected && (
                          <IconCheck size={16} stroke={2} color="var(--mantine-primary-color-filled)" />
                        )}
                      </Group>
                    </Combobox.Option>
                  ))}
                </Combobox.Options>
              </Combobox.Dropdown>
            </Combobox>
          </Box>
          <Tooltip
            label="No previous version to compare with"
            disabled={canCompare || !!compareBlocks}
            withArrow
            events={{ hover: true, focus: true, touch: true }}
          >
            <Box>
              <Button
                variant="default"
                leftSection={compareBlocks ? undefined : <IconLayersDifference size={16} />}
                loading={compareLoading}
                disabled={schemaLoading || !canCompare}
                onClick={toggleCompare}
              >
                {compareBlocks ? 'Back to schema' : 'Compare with previous'}
              </Button>
            </Box>
          </Tooltip>
        </Group>

        {compareError && <CheckResult {...checkResultErrorProps(compareError)} />}

        <Input.Wrapper label={compareBlocks ? 'Diff' : 'Definition'}>
          {schemaLoading || compareLoading ? (
            <Skeleton h={320} />
          ) : compareBlocks ? (
            <SchemaDiffView blocks={compareBlocks} emptyLabel="No changes" />
          ) : (
            <SchemaHighlight code={generateSchemaText(entities)} />
          )}
        </Input.Wrapper>
      </Stack>
    </PageShell>
  )
}

interface RelationshipsFilterState {
  snapToken: string
  entityType: string
  entityId: string
  relation: string
  subjectType: string
  subjectId: string
  pageSize: string
}

interface RelationshipsQuery {
  snapToken: string
  entityType: string
  entityIds: string[]
  relation: string
  subjectType: string
  subjectIds: string[]
  pageSize?: number
}

interface LookupEntityQuery {
  entityType: string
  permission: string
  subjectType: string
  subjectId: string
  snapToken: string
}

interface LookupSubjectQuery {
  entityType: string
  entityId: string
  permission: string
  subjectType: string
  subjectRelation?: string
  snapToken: string
}

type ResponsiveGridSpan = number | 'auto' | 'content' | Partial<Record<'base' | 'xs' | 'sm' | 'md' | 'lg' | 'xl', number | 'auto' | 'content'>>

const DEFAULT_RELATIONSHIPS_PAGE_SIZE = '100'
const RELATIONSHIPS_PAGE_SIZE_OPTIONS = [
  { value: '50', label: '50' },
  { value: '100', label: '100' },
  { value: '250', label: '250' },
  { value: '500', label: '500' },
  { value: 'all', label: 'All' },
]

const EMPTY_FILTERS: RelationshipsFilterState = {
  snapToken: '',
  entityType: '',
  entityId: '',
  relation: '',
  subjectType: '',
  subjectId: '',
  pageSize: DEFAULT_RELATIONSHIPS_PAGE_SIZE,
}

function FilterInput({
  label,
  placeholder,
  span,
  value,
  onChange,
}: {
  label: string
  placeholder: string
  span: ResponsiveGridSpan
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Grid.Col span={span}>
      <TextInput
        label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Grid.Col>
  )
}

function TuplesScreen({ api }: { api: ApiClient }) {
  const [filters, setFilters] = useState<RelationshipsFilterState>(EMPTY_FILTERS)
  const [tuples, setTuples] = useState<TupleRecord[]>([])
  const [continuousToken, setContinuousToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [filtersExpanded, setFiltersExpanded] = useState(true)
  const [appliedFilter, setAppliedFilter] = useState<RelationshipsQuery | null>(null)

  function setFilter<K extends keyof RelationshipsFilterState>(key: K, value: RelationshipsFilterState[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  function normalizedFilter(): RelationshipsQuery {
    return {
      snapToken: filters.snapToken.trim(),
      entityType: filters.entityType.trim(),
      entityIds: filters.entityId.trim() ? [filters.entityId.trim()] : [],
      relation: filters.relation.trim(),
      subjectType: filters.subjectType.trim(),
      subjectIds: filters.subjectId.trim() ? [filters.subjectId.trim()] : [],
      pageSize: filters.pageSize === 'all' ? undefined : parseInt(filters.pageSize, 10),
    }
  }

  const activeFilterItems = [
    appliedFilter?.entityType ? { label: 'Entity Type', value: appliedFilter.entityType } : null,
    appliedFilter?.entityIds[0] ? { label: 'Entity ID', value: appliedFilter.entityIds[0] } : null,
    appliedFilter?.relation ? { label: 'Relation', value: appliedFilter.relation } : null,
    appliedFilter?.subjectType ? { label: 'Subject Type', value: appliedFilter.subjectType } : null,
    appliedFilter?.subjectIds[0] ? { label: 'Subject ID', value: appliedFilter.subjectIds[0] } : null,
    appliedFilter?.snapToken ? { label: 'Snap Token', value: appliedFilter.snapToken } : null,
    appliedFilter
      ? { label: 'Page Size', value: appliedFilter.pageSize === undefined ? 'All records' : String(appliedFilter.pageSize) }
      : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item))

  async function readAllRelationships(query: RelationshipsQuery) {
    const allTuples: TupleRecord[] = []
    let token = ''

    do {
      const result = await api.readRelationships({ ...query, continuousToken: token })
      allTuples.push(...result.tuples)
      token = result.continuousToken
    } while (token)

    return allTuples
  }

  async function fetchTuples() {
    const query = normalizedFilter()
    setLoading(true)
    setError(null)

    try {
      if (query.pageSize === undefined) {
        setTuples(await readAllRelationships(query))
        setContinuousToken('')
      } else {
        const result = await api.readRelationships(query)
        setTuples(result.tuples)
        setContinuousToken(result.continuousToken)
      }

      setAppliedFilter(query)
      setLoaded(true)
      setFiltersExpanded(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error('unknown error'))
    } finally {
      setLoading(false)
    }
  }

  async function loadMore() {
    if (!appliedFilter || !continuousToken) {
      return
    }

    setLoadingMore(true)
    setError(null)

    try {
      const result = await api.readRelationships({ ...appliedFilter, continuousToken })
      setTuples((prev) => [...prev, ...result.tuples])
      setContinuousToken(result.continuousToken)
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error('unknown error'))
    } finally {
      setLoadingMore(false)
    }
  }

  function reset() {
    setFilters(EMPTY_FILTERS)
    setTuples([])
    setContinuousToken('')
    setLoaded(false)
    setFiltersExpanded(true)
    setAppliedFilter(null)
  }

  const tuplesTable = (
    <Table stickyHeader>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Entity Type</Table.Th>
          <Table.Th>Entity ID</Table.Th>
          <Table.Th>Relation</Table.Th>
          <Table.Th>Subject Type</Table.Th>
          <Table.Th>Subject ID</Table.Th>
          <Table.Th>Subject Relation</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {tuples.length === 0 ? (
          <Table.Tr>
            <Table.Td colSpan={6} ta="center" py="xl">
              <Text c="dimmed">No records</Text>
            </Table.Td>
          </Table.Tr>
        ) : tuples.map((tuple) => (
          <Table.Tr key={`${tuple.entity.type}:${tuple.entity.id}:${tuple.relation}:${tuple.subject.type}:${tuple.subject.id}:${tuple.subject.relation}`}>
            <Table.Td>{tuple.entity.type}</Table.Td>
            <Table.Td>{tuple.entity.id}</Table.Td>
            <Table.Td>{tuple.relation}</Table.Td>
            <Table.Td>{tuple.subject.type}</Table.Td>
            <Table.Td>{tuple.subject.id}</Table.Td>
            <Table.Td c="dimmed">{tuple.subject.relation || '—'}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  )

  return (
    <PageShell wide>
      <Stack gap="xl">
        <PageHeader title="Relations" />
        <form
          onSubmit={(event) => {
            event.preventDefault()
            fetchTuples()
          }}
        >
        <Fieldset legend="Filters">
          <Stack gap={0}>
            <Collapse in={loaded && !filtersExpanded}>
              <Group justify="space-between" align="center" wrap="nowrap">
                <Box style={{ flex: 1, minWidth: 0 }}>
                  {activeFilterItems.length > 0 ? (
                    <Group gap="xs">
                      {activeFilterItems.map((item) => (
                        <Badge key={`${item.label}:${item.value}`} variant="light" color="gray">
                          {item.label}: {item.value}
                        </Badge>
                      ))}
                    </Group>
                  ) : (
                    <Text size="sm" c="dimmed">All relationships</Text>
                  )}
                </Box>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={() => setFiltersExpanded(true)}
                  aria-label="Show filters"
                >
                  <IconChevronDown size={16} />
                </ActionIcon>
              </Group>
            </Collapse>
            <Collapse in={filtersExpanded}>
              <Stack gap="md">
                <Grid gutter="md">
                  <FilterInput label="Entity Type" placeholder="any" span={{ base: 12, sm: 6, lg: 4 }} value={filters.entityType} onChange={(value) => setFilter('entityType', value)} />
                  <FilterInput label="Entity ID" placeholder="any" span={{ base: 12, sm: 6, lg: 4 }} value={filters.entityId} onChange={(value) => setFilter('entityId', value)} />
                  <FilterInput label="Relation" placeholder="any" span={{ base: 12, sm: 6, lg: 4 }} value={filters.relation} onChange={(value) => setFilter('relation', value)} />
                  <FilterInput label="Subject Type" placeholder="any" span={{ base: 12, sm: 6, lg: 4 }} value={filters.subjectType} onChange={(value) => setFilter('subjectType', value)} />
                  <FilterInput label="Subject ID" placeholder="any" span={{ base: 12, sm: 6, lg: 4 }} value={filters.subjectId} onChange={(value) => setFilter('subjectId', value)} />
                  <FilterInput label="Snap Token" placeholder="latest" span={{ base: 12, sm: 6, lg: 4 }} value={filters.snapToken} onChange={(value) => setFilter('snapToken', value)} />
                </Grid>
                <Group justify="space-between" align="center" wrap="wrap" gap="md">
                  <Group gap="sm">
                    <Button type="submit" loading={loading}>Load</Button>
                    <Button type="button" variant="default" onClick={reset}>Reset</Button>
                  </Group>
                  <Group gap="sm" align="center" wrap="nowrap">
                    <Text size="sm" fw={500}>Page size</Text>
                    <SegmentedControl
                      data={RELATIONSHIPS_PAGE_SIZE_OPTIONS}
                      value={filters.pageSize}
                      onChange={(value) => setFilter('pageSize', value ?? DEFAULT_RELATIONSHIPS_PAGE_SIZE)}
                    />
                    {loaded && (
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        onClick={() => setFiltersExpanded(false)}
                        aria-label="Hide filters"
                      >
                        <IconChevronUp size={16} />
                      </ActionIcon>
                    )}
                  </Group>
                </Group>
              </Stack>
            </Collapse>
          </Stack>
        </Fieldset>
        </form>

        {error && <CheckResult {...checkResultErrorProps(error)} />}

        {!loaded && !error && (
          <Text size="sm" c="dimmed">Press Load to fetch relationships</Text>
        )}

        {loaded && (
          <Stack gap="sm">
            <Text size="sm">
              <Text component="span" fw={500}>
                {tuples.length} {tuples.length === 1 ? 'record' : 'records'}
              </Text>
              {continuousToken && (
                <Text component="span" c="dimmed"> · more available</Text>
              )}
            </Text>
            <Table.ScrollContainer minWidth={900} type="native">
              {tuplesTable}
            </Table.ScrollContainer>
            {continuousToken && (
              <Group justify="flex-end">
                <Button variant="default" onClick={loadMore} loading={loadingMore}>Load more</Button>
              </Group>
            )}
          </Stack>
        )}
      </Stack>
    </PageShell>
  )
}

function req(value: string, validated: boolean) {
  return validated && !value.trim() ? 'Required' : undefined
}

function ActionCard({
  actionLabel,
  children,
  loading,
  onAction,
}: {
  actionLabel: string
  children: ReactNode
  loading: boolean
  onAction: () => void
}) {
  return (
    <Fieldset>
      <Stack gap="md">
        {children}
        <Button type="button" onClick={onAction} loading={loading} w="fit-content">
          {actionLabel}
        </Button>
      </Stack>
    </Fieldset>
  )
}

function LookupListResult({
  values,
  singularNoun,
  pluralNoun,
  continuousToken,
  onLoadMore,
  loadingMore,
}: {
  values: string[]
  singularNoun: string
  pluralNoun: string
  continuousToken?: string
  onLoadMore?: () => void
  loadingMore?: boolean
}) {
  return (
    <Stack gap="xs">
      <Text size="sm">
        <Text component="span" fw={500}>
          {values.length} {values.length === 1 ? singularNoun : pluralNoun} found
        </Text>
        {continuousToken && (
          <Text component="span" c="dimmed"> · more available</Text>
        )}
      </Text>
      <Group gap="xs">
        {values.map((value) => (
          <Badge key={value} variant="light" color="gray">
            {value}
          </Badge>
        ))}
      </Group>
      {continuousToken && onLoadMore && (
        <Group justify="flex-end">
          <Button variant="default" onClick={onLoadMore} loading={loadingMore}>Load more</Button>
        </Group>
      )}
    </Stack>
  )
}

function CheckResultPanel({
  result,
  subjectType,
  subjectId,
  subjectRelation,
  explainTree,
  explainError,
}: {
  result: CheckResult
  subjectType: string
  subjectId: string
  subjectRelation: string
  explainTree: ExpandTreeNode | null
  explainError: Error | null
}) {
  const allowed = result.can === 'CHECK_RESULT_ALLOWED'

  return (
    <Stack gap="sm">
      <CheckResult
        status={allowed ? 'allowed' : 'denied'}
        expandTree={explainTree}
        checkedSubject={{
          type: subjectType,
          id: subjectId,
          relation: subjectRelation,
        }}
        emptyMessage={
          !explainError
            ? 'No relation path connects the subject to the requested permission.'
            : undefined
        }
      />

      {explainError && <CheckResult {...checkResultErrorProps(explainError)} />}
    </Stack>
  )
}

interface CheckHistoryEntry {
  entityType: string
  entityId: string
  permission: string
  subjectType: string
  subjectId: string
  subjectRelation: string
  snapToken: string
  result: CheckResult['can']
  ts: number
}

interface EntityLookupHistoryEntry {
  entityType: string
  permission: string
  subjectType: string
  subjectId: string
  snapToken: string
  ts: number
}

interface SubjectLookupHistoryEntry {
  entityType: string
  entityId: string
  permission: string
  subjectType: string
  subjectRelation: string
  snapToken: string
  ts: number
}

const FORM_HISTORY_LIMIT = 20

function checkHistoryStorageKey(tenant: string) {
  return `permify-ui.check-history.${tenant}`
}

function entityLookupHistoryStorageKey(tenant: string) {
  return `permify-ui.entity-lookup-history.${tenant}`
}

function subjectLookupHistoryStorageKey(tenant: string) {
  return `permify-ui.subject-lookup-history.${tenant}`
}

function loadFormHistory<T>(tenant: string, storageKey: string): T[] {
  if (!tenant) return []
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveFormHistory<T>(tenant: string, storageKey: string, history: T[]) {
  if (!tenant) return
  try {
    localStorage.setItem(storageKey, JSON.stringify(history))
  } catch {
    // localStorage may throw in private mode / quota; ignore
  }
}

function checkHistoryKey(entry: Pick<CheckHistoryEntry, 'entityType' | 'entityId' | 'permission' | 'subjectType' | 'subjectId' | 'subjectRelation' | 'snapToken'>) {
  return [
    entry.entityType,
    entry.entityId,
    entry.permission,
    entry.subjectType,
    entry.subjectId,
    entry.subjectRelation,
    entry.snapToken,
  ].join('\0')
}

function entityLookupHistoryKey(entry: Pick<EntityLookupHistoryEntry, 'entityType' | 'permission' | 'subjectType' | 'subjectId' | 'snapToken'>) {
  return [entry.entityType, entry.permission, entry.subjectType, entry.subjectId, entry.snapToken].join('\0')
}

function subjectLookupHistoryKey(entry: Pick<SubjectLookupHistoryEntry, 'entityType' | 'entityId' | 'permission' | 'subjectType' | 'subjectRelation' | 'snapToken'>) {
  return [
    entry.entityType,
    entry.entityId,
    entry.permission,
    entry.subjectType,
    entry.subjectRelation,
    entry.snapToken,
  ].join('\0')
}

function useFormHistory<T>(
  tenant: string,
  storageKey: string,
  entryKey: (entry: T) => string,
) {
  const [history, setHistory] = useState<T[]>([])

  useEffect(() => {
    setHistory(loadFormHistory<T>(tenant, storageKey))
  }, [tenant, storageKey])

  function pushHistory(entry: T) {
    setHistory((prev) => {
      const next = [entry, ...prev.filter((item) => entryKey(item) !== entryKey(entry))].slice(0, FORM_HISTORY_LIMIT)
      saveFormHistory(tenant, storageKey, next)
      return next
    })
  }

  return { history, pushHistory }
}

function formatSubjectCell(entry: Pick<CheckHistoryEntry, 'subjectType' | 'subjectId' | 'subjectRelation'>): string {
  const base = `${entry.subjectType}:${entry.subjectId}`
  return entry.subjectRelation ? `${base}#${entry.subjectRelation}` : base
}

function formatEntityCell(entry: Pick<CheckHistoryEntry, 'entityType' | 'entityId'>): string {
  return `${entry.entityType}:${entry.entityId}`
}

type CheckQueryFields = Pick<CheckHistoryEntry, 'entityType' | 'entityId' | 'permission' | 'subjectType' | 'subjectId' | 'subjectRelation'>

function formatCheckQueryLine(fields: CheckQueryFields): string {
  return `${formatEntityCell(fields)} · ${fields.permission} · ${formatSubjectCell(fields)}`
}

function CheckQueryLineText({ fields }: { fields: CheckQueryFields }) {
  return (
    <>
      {formatEntityCell(fields)}
      <Text component="span" c="dimmed" inherit>
        {' · '}
      </Text>
      {fields.permission}
      <Text component="span" c="dimmed" inherit>
        {' · '}
      </Text>
      {formatSubjectCell(fields)}
    </>
  )
}

function formatEntityLookupLine(fields: Pick<EntityLookupHistoryEntry, 'entityType' | 'permission' | 'subjectType' | 'subjectId'>): string {
  return `${fields.entityType} · ${fields.permission} · ${fields.subjectType}:${fields.subjectId}`
}

function EntityLookupQueryLineText({ fields }: { fields: Pick<EntityLookupHistoryEntry, 'entityType' | 'permission' | 'subjectType' | 'subjectId'> }) {
  return (
    <>
      {fields.entityType}
      <Text component="span" c="dimmed" inherit>
        {' · '}
      </Text>
      {fields.permission}
      <Text component="span" c="dimmed" inherit>
        {' · '}
      </Text>
      {`${fields.subjectType}:${fields.subjectId}`}
    </>
  )
}

function formatSubjectLookupSubject(fields: Pick<SubjectLookupHistoryEntry, 'subjectType' | 'subjectRelation'>): string {
  return fields.subjectRelation ? `${fields.subjectType}#${fields.subjectRelation}` : fields.subjectType
}

function formatSubjectLookupLine(fields: Pick<SubjectLookupHistoryEntry, 'entityType' | 'entityId' | 'permission' | 'subjectType' | 'subjectRelation'>): string {
  return `${formatEntityCell(fields)} · ${fields.permission} · ${formatSubjectLookupSubject(fields)}`
}

function SubjectLookupQueryLineText({ fields }: { fields: Pick<SubjectLookupHistoryEntry, 'entityType' | 'entityId' | 'permission' | 'subjectType' | 'subjectRelation'> }) {
  return (
    <>
      {formatEntityCell(fields)}
      <Text component="span" c="dimmed" inherit>
        {' · '}
      </Text>
      {fields.permission}
      <Text component="span" c="dimmed" inherit>
        {' · '}
      </Text>
      {formatSubjectLookupSubject(fields)}
    </>
  )
}

function LastFormHistoryRow({
  label,
  summary,
  onUse,
  children,
}: {
  label: string
  summary: string
  onUse: () => void
  children: ReactNode
}) {
  return (
    <Text size="sm" lh={1.35} style={{ overflowWrap: 'anywhere' }}>
      <Text component="span" c="dimmed">{label}</Text>
      <Anchor
        component="button"
        type="button"
        c="var(--mantine-color-text)"
        underline="hover"
        aria-label={`Fill form with ${summary}`}
        onClick={onUse}
      >
        {children}
      </Anchor>
    </Text>
  )
}

function useCheckHistory(tenant: string) {
  const storageKey = checkHistoryStorageKey(tenant)
  return useFormHistory<CheckHistoryEntry>(tenant, storageKey, checkHistoryKey)
}

function useEntityLookupHistory(tenant: string) {
  const storageKey = entityLookupHistoryStorageKey(tenant)
  return useFormHistory<EntityLookupHistoryEntry>(tenant, storageKey, entityLookupHistoryKey)
}

function useSubjectLookupHistory(tenant: string) {
  const storageKey = subjectLookupHistoryStorageKey(tenant)
  return useFormHistory<SubjectLookupHistoryEntry>(tenant, storageKey, subjectLookupHistoryKey)
}

function ResourceCheckTab({ api, tenant }: { api: ApiClient; tenant: string }) {
  const [entityType, setEntityType] = useState('')
  const [entityId, setEntityId] = useState('')
  const [permission, setPermission] = useState('')
  const [subjectType, setSubjectType] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [subjectRelation, setSubjectRelation] = useState('')
  const [snapToken, setSnapToken] = useState('')
  const [result, setResult] = useState<CheckResult | null>(null)
  const [resultSubject, setResultSubject] = useState<{ type: string; id: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [validated, setValidated] = useState(false)
  const [explainTree, setExplainTree] = useState<ExpandTreeNode | null>(null)
  const [explainError, setExplainError] = useState<Error | null>(null)
  const { history, pushHistory } = useCheckHistory(tenant)

  function applyHistoryEntry(entry: CheckHistoryEntry) {
    setEntityType(entry.entityType ?? '')
    setEntityId(entry.entityId ?? '')
    setPermission(entry.permission ?? '')
    setSubjectType(entry.subjectType ?? '')
    setSubjectId(entry.subjectId ?? '')
    setSubjectRelation(entry.subjectRelation ?? '')
    setSnapToken(entry.snapToken ?? '')
    setValidated(false)
    setError(null)
    setResult(null)
    setResultSubject(null)
    setExplainTree(null)
    setExplainError(null)
  }

  async function check() {
    setValidated(true)
    if (!entityType.trim() || !entityId.trim() || !permission.trim() || !subjectType.trim() || !subjectId.trim()) return

    const trimmedEntityType = entityType.trim()
    const trimmedEntityId = entityId.trim()
    const trimmedPermission = permission.trim()
    const trimmedSubjectType = subjectType.trim()
    const trimmedSubjectId = subjectId.trim()
    const trimmedSubjectRelation = subjectRelation.trim()
    const trimmedSnapToken = snapToken.trim()

    setLoading(true)
    setError(null)
    setResult(null)
    setResultSubject(null)
    setExplainTree(null)
    setExplainError(null)

    try {
      const checkResult = await api.checkPermission({
        entityType: trimmedEntityType,
        entityId: trimmedEntityId,
        permission: trimmedPermission,
        subjectType: trimmedSubjectType,
        subjectId: trimmedSubjectId,
        subjectRelation: trimmedSubjectRelation,
        snapToken: trimmedSnapToken,
      })
      setResult(checkResult)
      setResultSubject({ type: trimmedSubjectType, id: trimmedSubjectId })
      pushHistory({
        entityType: trimmedEntityType,
        entityId: trimmedEntityId,
        permission: trimmedPermission,
        subjectType: trimmedSubjectType,
        subjectId: trimmedSubjectId,
        subjectRelation: trimmedSubjectRelation,
        snapToken: trimmedSnapToken,
        result: checkResult.can,
        ts: Date.now(),
      })

      try {
        const tree = await api.expandPermission({
          entityType: trimmedEntityType,
          entityId: trimmedEntityId,
          permission: trimmedPermission,
          snapToken: trimmedSnapToken,
        })
        setExplainTree(tree)
      } catch (err: unknown) {
        setExplainError(err instanceof Error ? err : new Error('unknown error'))
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error('unknown error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Stack gap="xl">
      <PageHeader title="Resource check" description="Check whether a subject has a permission on a specific entity." />
      <ActionCard
        actionLabel="Check Access"
        loading={loading}
        onAction={check}
      >
        <Grid gutter="md">
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Entity Type" placeholder="organization" withAsterisk value={entityType} onChange={(event) => setEntityType(event.currentTarget.value)} error={req(entityType, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Entity ID" placeholder="acme" withAsterisk value={entityId} onChange={(event) => setEntityId(event.currentTarget.value)} error={req(entityId, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Permission" placeholder="view" withAsterisk value={permission} onChange={(event) => setPermission(event.currentTarget.value)} error={req(permission, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Subject Type" placeholder="person" withAsterisk value={subjectType} onChange={(event) => setSubjectType(event.currentTarget.value)} error={req(subjectType, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Subject ID" placeholder="user-42" withAsterisk value={subjectId} onChange={(event) => setSubjectId(event.currentTarget.value)} error={req(subjectId, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Subject Relation" value={subjectRelation} onChange={(event) => setSubjectRelation(event.currentTarget.value)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Snap Token" value={snapToken} onChange={(event) => setSnapToken(event.currentTarget.value)} /></Grid.Col>
        </Grid>
        {history[0] && (
          <LastFormHistoryRow
            label="Your last check: "
            summary={`your last check: ${formatCheckQueryLine(history[0])}`}
            onUse={() => applyHistoryEntry(history[0])}
          >
            <CheckQueryLineText fields={history[0]} />
          </LastFormHistoryRow>
        )}
      </ActionCard>
      {error && <CheckResult {...checkResultErrorProps(error)} />}
      {result && resultSubject && (
        <CheckResultPanel
          result={result}
          subjectType={resultSubject.type}
          subjectId={resultSubject.id}
          subjectRelation={subjectRelation}
          explainTree={explainTree}
          explainError={explainError}
        />
      )}
    </Stack>
  )
}

function LookupEntityTab({ api, tenant }: { api: ApiClient; tenant: string }) {
  const [entityType, setEntityType] = useState('')
  const [permission, setPermission] = useState('')
  const [subjectType, setSubjectType] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [snapToken, setSnapToken] = useState('')
  const [entityIds, setEntityIds] = useState<string[]>([])
  const [continuousToken, setContinuousToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [validated, setValidated] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const lastQueryRef = useRef<LookupEntityQuery | null>(null)
  const { history, pushHistory } = useEntityLookupHistory(tenant)

  function applyHistoryEntry(entry: EntityLookupHistoryEntry) {
    setEntityType(entry.entityType ?? '')
    setPermission(entry.permission ?? '')
    setSubjectType(entry.subjectType ?? '')
    setSubjectId(entry.subjectId ?? '')
    setSnapToken(entry.snapToken ?? '')
    setValidated(false)
    setError(null)
    setLoaded(false)
    setEntityIds([])
    setContinuousToken('')
    lastQueryRef.current = null
  }

  function normalizedQuery(): LookupEntityQuery {
    return {
      entityType: entityType.trim(),
      permission: permission.trim(),
      subjectType: subjectType.trim(),
      subjectId: subjectId.trim(),
      snapToken: snapToken.trim(),
    }
  }

  async function lookup() {
    const query = normalizedQuery()
    setValidated(true)
    if (!query.entityType || !query.permission || !query.subjectType || !query.subjectId) return

    setLoading(true)
    setError(null)
    setLoaded(false)
    setEntityIds([])
    setContinuousToken('')

    try {
      const result = await api.lookupEntity(query)
      lastQueryRef.current = query
      setEntityIds(result.entityIds)
      setContinuousToken(result.continuousToken)
      setLoaded(true)
      pushHistory({ ...query, ts: Date.now() })
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error('unknown error'))
    } finally {
      setLoading(false)
    }
  }

  async function loadMore() {
    if (!lastQueryRef.current || !continuousToken) {
      return
    }

    setLoadingMore(true)
    setError(null)

    try {
      const result = await api.lookupEntity({ ...lastQueryRef.current, continuousToken })
      setEntityIds((prev) => [...prev, ...result.entityIds])
      setContinuousToken(result.continuousToken)
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error('unknown error'))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <Stack gap="xl">
      <PageHeader title="Entity lookup" description="Find which entities a subject can access with a given permission." />
      <ActionCard
        actionLabel="Lookup Entities"
        loading={loading}
        onAction={lookup}
      >
        <Grid gutter="md">
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Entity Type" placeholder="organization" withAsterisk value={entityType} onChange={(event) => setEntityType(event.currentTarget.value)} error={req(entityType, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Permission" placeholder="view" withAsterisk value={permission} onChange={(event) => setPermission(event.currentTarget.value)} error={req(permission, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Subject Type" placeholder="person" withAsterisk value={subjectType} onChange={(event) => setSubjectType(event.currentTarget.value)} error={req(subjectType, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Subject ID" placeholder="user-42" withAsterisk value={subjectId} onChange={(event) => setSubjectId(event.currentTarget.value)} error={req(subjectId, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Snap Token" value={snapToken} onChange={(event) => setSnapToken(event.currentTarget.value)} /></Grid.Col>
        </Grid>
        {history[0] && (
          <LastFormHistoryRow
            label="Your last entity lookup: "
            summary={`your last entity lookup: ${formatEntityLookupLine(history[0])}`}
            onUse={() => applyHistoryEntry(history[0])}
          >
            <EntityLookupQueryLineText fields={history[0]} />
          </LastFormHistoryRow>
        )}
      </ActionCard>
      {error && <CheckResult {...checkResultErrorProps(error)} />}
      {loaded && (
        <LookupListResult
          values={entityIds}
          singularNoun="entity"
          pluralNoun="entities"
          continuousToken={continuousToken}
          onLoadMore={loadMore}
          loadingMore={loadingMore}
        />
      )}
    </Stack>
  )
}

function LookupSubjectTab({ api, tenant }: { api: ApiClient; tenant: string }) {
  const [entityType, setEntityType] = useState('')
  const [entityId, setEntityId] = useState('')
  const [permission, setPermission] = useState('')
  const [subjectType, setSubjectType] = useState('')
  const [subjectRelation, setSubjectRelation] = useState('')
  const [snapToken, setSnapToken] = useState('')
  const [subjectIds, setSubjectIds] = useState<string[]>([])
  const [continuousToken, setContinuousToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [validated, setValidated] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const lastQueryRef = useRef<LookupSubjectQuery | null>(null)
  const { history, pushHistory } = useSubjectLookupHistory(tenant)

  function applyHistoryEntry(entry: SubjectLookupHistoryEntry) {
    setEntityType(entry.entityType ?? '')
    setEntityId(entry.entityId ?? '')
    setPermission(entry.permission ?? '')
    setSubjectType(entry.subjectType ?? '')
    setSubjectRelation(entry.subjectRelation ?? '')
    setSnapToken(entry.snapToken ?? '')
    setValidated(false)
    setError(null)
    setLoaded(false)
    setSubjectIds([])
    setContinuousToken('')
    lastQueryRef.current = null
  }

  function normalizedQuery(): LookupSubjectQuery {
    return {
      entityType: entityType.trim(),
      entityId: entityId.trim(),
      permission: permission.trim(),
      subjectType: subjectType.trim(),
      subjectRelation: subjectRelation.trim(),
      snapToken: snapToken.trim(),
    }
  }

  async function lookup() {
    const query = normalizedQuery()
    setValidated(true)
    if (!query.entityType || !query.entityId || !query.permission || !query.subjectType) return

    setLoading(true)
    setError(null)
    setLoaded(false)
    setSubjectIds([])
    setContinuousToken('')

    try {
      const result = await api.lookupSubject(query)
      lastQueryRef.current = query
      setSubjectIds(result.subjectIds)
      setContinuousToken(result.continuousToken)
      setLoaded(true)
      pushHistory({
        entityType: query.entityType,
        entityId: query.entityId,
        permission: query.permission,
        subjectType: query.subjectType,
        subjectRelation: query.subjectRelation ?? '',
        snapToken: query.snapToken,
        ts: Date.now(),
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error('unknown error'))
    } finally {
      setLoading(false)
    }
  }

  async function loadMore() {
    if (!lastQueryRef.current || !continuousToken) {
      return
    }

    setLoadingMore(true)
    setError(null)

    try {
      const result = await api.lookupSubject({ ...lastQueryRef.current, continuousToken })
      setSubjectIds((prev) => [...prev, ...result.subjectIds])
      setContinuousToken(result.continuousToken)
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error('unknown error'))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <Stack gap="xl">
      <PageHeader title="Subject lookup" description="Find which subjects have a given permission on an entity." />
      <ActionCard
        actionLabel="Lookup Subjects"
        loading={loading}
        onAction={lookup}
      >
        <Grid gutter="md">
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Entity Type" placeholder="organization" withAsterisk value={entityType} onChange={(event) => setEntityType(event.currentTarget.value)} error={req(entityType, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Entity ID" placeholder="acme" withAsterisk value={entityId} onChange={(event) => setEntityId(event.currentTarget.value)} error={req(entityId, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Permission" placeholder="view" withAsterisk value={permission} onChange={(event) => setPermission(event.currentTarget.value)} error={req(permission, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Subject Type" placeholder="person" withAsterisk value={subjectType} onChange={(event) => setSubjectType(event.currentTarget.value)} error={req(subjectType, validated)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Subject Relation" value={subjectRelation} onChange={(event) => setSubjectRelation(event.currentTarget.value)} /></Grid.Col>
          <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}><TextInput label="Snap Token" value={snapToken} onChange={(event) => setSnapToken(event.currentTarget.value)} /></Grid.Col>
        </Grid>
        {history[0] && (
          <LastFormHistoryRow
            label="Your last subject lookup: "
            summary={`your last subject lookup: ${formatSubjectLookupLine(history[0])}`}
            onUse={() => applyHistoryEntry(history[0])}
          >
            <SubjectLookupQueryLineText fields={history[0]} />
          </LastFormHistoryRow>
        )}
      </ActionCard>
      {error && <CheckResult {...checkResultErrorProps(error)} />}
      {loaded && (
        <LookupListResult
          values={subjectIds}
          singularNoun="subject"
          pluralNoun="subjects"
          continuousToken={continuousToken}
          onLoadMore={loadMore}
          loadingMore={loadingMore}
        />
      )}
    </Stack>
  )
}

function CheckScreen({ api, mode, tenant }: { api: ApiClient; mode: CheckMode; tenant: string }) {
  return (
    <PageShell>
      {mode === 'check' && <ResourceCheckTab api={api} tenant={tenant} />}
      {mode === 'lookup' && <LookupEntityTab api={api} tenant={tenant} />}
      {mode === 'subject' && <LookupSubjectTab api={api} tenant={tenant} />}
    </PageShell>
  )
}

export function App() {
  const initialLocation = readLocationState()
  const [page, setPage] = useState<Page>(() => initialLocation.page)
  const [checkMode, setCheckMode] = useState<CheckMode>(() => initialLocation.checkMode)
  const [checkNavOpened, setCheckNavOpened] = useState(() => initialLocation.page === 'check')
  const [schemaScreenKey, setSchemaScreenKey] = useState(0)
  const [checkScreenKey, setCheckScreenKey] = useState(0)
  const [mobileNavbarOpened, setMobileNavbarOpened] = useState(false)
  const [authEnabled, setAuthEnabled] = useState(false)
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [configReady, setConfigReady] = useState(false)
  const [email, setEmail] = useState('')
  const [provider, setProvider] = useState('')
  const [permifyUrl, setPermifyUrl] = useState('')
  const [tenant, setTenant] = useState('')
  const api = useMemo(() => createApiClient(tenant), [tenant])

  async function checkConnection() {
    setConnected(null)
    try {
      await ping()
      setConnected(true)
    } catch {
      setConnected(false)
    }
  }

  useEffect(() => {
    getAppConfig()
      .then((data) => {
        setAuthEnabled(data.enabled)
        setProvider(data.provider)
        setPermifyUrl(data.permify_url)
        setTenant(data.tenant)
      })
      .catch(() => setConnected(false))
      .finally(() => setConfigReady(true))
    getCurrentUser()
      .then((data) => {
        setAuthed(true)
        setEmail(data.email)
      })
      .catch(() => setAuthed(false))
    checkConnection()
  }, [])

  useEffect(() => {
    function onPopState() {
      const { page: nextPage, checkMode: nextCheckMode } = readLocationState()
      setPage(nextPage)
      setCheckMode(nextCheckMode)
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  function navigate(nextPage: Page) {
    setPage(nextPage)
    setMobileNavbarOpened(false)
    if (nextPage === 'schema') {
      window.history.pushState(null, '', '/')
      return
    }
    if (nextPage === 'check') {
      setCheckMode('check')
      window.history.pushState(null, '', checkAccessUrl('check'))
      return
    }
    window.history.pushState(null, '', `/?page=${nextPage}`)
  }

  function navigateToCheck(mode: CheckMode) {
    setPage('check')
    setCheckNavOpened(true)
    setMobileNavbarOpened(false)
    if (page === 'check' && checkMode === mode) {
      setCheckScreenKey((current) => current + 1)
    } else {
      setCheckMode(mode)
    }
    window.history.pushState(null, '', checkAccessUrl(mode))
  }

  function navigateHome() {
    setSchemaScreenKey((current) => current + 1)
    setPage('schema')
    setMobileNavbarOpened(false)
    window.history.pushState(null, '', '/')
  }

  if (authed === null || connected === null || !configReady) return <Loader m="xl" />
  if (authEnabled && !authed) return <LoginScreen provider={provider} />
  if (!connected || !tenant) return <ConnectionScreen permifyUrl={permifyUrl} onRetry={checkConnection} />

  return (
    <AppShell
      header={{ height: { base: 56, sm: 0 } }}
      navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: !mobileNavbarOpened } }}
      padding={0}
    >
      <AppShell.Header hiddenFrom="sm">
        <Group h="100%" px="md" gap="sm" wrap="nowrap">
          <Burger opened={mobileNavbarOpened} onClick={() => setMobileNavbarOpened((current) => !current)} size="sm" aria-label="Toggle navigation" />
          <UnstyledButton onClick={navigateHome}>
            <Text fw={500}>Permify UI</Text>
          </UnstyledButton>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar>
        <AppShell.Section px="lg" pt="xl" pb="md" mb="md">
          <UnstyledButton onClick={navigateHome}>
            <Title order={4}>Permify UI</Title>
          </UnstyledButton>
        </AppShell.Section>

        <AppShell.Section grow component="nav">
          <NavLink
            component="a"
            href="#"
            active={page === 'schema'}
            leftSection={<IconBraces size={16} />}
            label="Schemas"
            onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault()
              navigate('schema')
            }}
          />
          <NavLink
            component="a"
            href="#"
            active={page === 'relations'}
            leftSection={<IconArrowsExchange size={16} />}
            label="Relations"
            onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault()
              navigate('relations')
            }}
          />
          <NavLink
            component="a"
            href="#"
            label="Check access"
            leftSection={<IconLockCheck size={16} />}
            opened={checkNavOpened}
            onChange={setCheckNavOpened}
            onClick={(event: React.MouseEvent<HTMLAnchorElement>) => event.preventDefault()}
            styles={{
              children: {
                marginInlineStart: 'calc(var(--mantine-spacing-lg) + 8px)',
                paddingInlineStart: 0,
                borderInlineStart: '1px solid var(--mantine-color-default-border)',
              },
            }}
          >
            {CHECK_MODES.map(({ mode, label }) => (
              <NavLink
                key={mode}
                component="a"
                href="#"
                label={label}
                active={page === 'check' && checkMode === mode}
                styles={{
                  root: {
                    paddingLeft: 'var(--mantine-spacing-sm)',
                    paddingRight: 'var(--mantine-spacing-sm)',
                  },
                }}
                onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
                  event.preventDefault()
                  navigateToCheck(mode)
                }}
              />
            ))}
          </NavLink>
        </AppShell.Section>

        <NavbarFooter authEnabled={authEnabled} email={email} />
      </AppShell.Navbar>

      <AppShell.Main>
        {page === 'schema' && <SchemaScreen key={schemaScreenKey} api={api} />}
        {page === 'relations' && <TuplesScreen api={api} />}
        {page === 'check' && <CheckScreen key={`${checkMode}-${checkScreenKey}`} api={api} mode={checkMode} tenant={tenant} />}
      </AppShell.Main>
    </AppShell>
  )
}
