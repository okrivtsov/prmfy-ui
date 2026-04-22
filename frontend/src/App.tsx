import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconArrowsExchange, IconBraces, IconChevronDown, IconLayersDifference, IconLockCheck, IconLogout, IconMoon, IconServerOff, IconSun } from '@tabler/icons-react'
import { ActionIcon, Alert, AppShell, Badge, Box, Burger, Button, Card, Code, Combobox, Container, Grid, Group, InputBase, Loader, NavLink, Pill, ScrollArea, Select, Stack, Table, Tabs, Text, TextInput, Title, Tooltip, UnstyledButton, useCombobox, useMantineColorScheme } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'

type Page = 'schema' | 'relations' | 'check'

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

class ApiError extends Error {
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
  }
}

function parsePage(value: string | null): Page {
  if (value === 'relations' || value === 'check') return value
  return 'schema'
}

function ThemeToggle() {
  const { colorScheme, setColorScheme } = useMantineColorScheme()
  const activeColorScheme = colorScheme === 'dark' ? 'dark' : 'light'
  const nextColorScheme = activeColorScheme === 'dark' ? 'light' : 'dark'
  const label = activeColorScheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
  const Icon = activeColorScheme === 'dark' ? IconSun : IconMoon

  return (
    <Tooltip label={label} position="top">
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={label}
        onClick={() => setColorScheme(nextColorScheme)}
      >
        <Icon size={16} />
      </ActionIcon>
    </Tooltip>
  )
}

function ConnectionScreen({ permifyUrl, onRetry }: { permifyUrl: string; onRetry: () => void }) {
  return (
    <Stack align="center" justify="center" h="100vh" bg="var(--mantine-color-body)">
      <Container size={400} w="100%">
        <Card withBorder shadow="sm" p="xl">
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
        <Card withBorder shadow="sm" p="xl">
          <Stack align="center">
            <Title order={2} fw={600}>Permify UI</Title>
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

function SchemaHighlight({ code }: { code: string }) {
  const lines = code.split('\n')

  return (
    <Code
      block
      styles={{
        root: {
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.68,
          fontSize: '13px',
          background: 'transparent',
          border: 0,
          padding: 0,
        },
      }}
    >
      {lines.map((line, lineIndex) => <div key={lineIndex}>{tokenizeLine(line)}</div>)}
    </Code>
  )
}

function SchemaDiffView({ blocks, emptyLabel }: { blocks: SchemaDiffBlock[]; emptyLabel: string }) {
  if (blocks.length === 0) {
    return <Text size="sm" c="dimmed">{emptyLabel}</Text>
  }

  return (
    <Stack gap="xl">
      {blocks.map((block) => {
        const titleColor =
          block.kind === 'added'
            ? 'var(--schema-diff-added)'
            : block.kind === 'removed'
              ? 'var(--schema-diff-removed)'
              : 'var(--mantine-color-text)'

        return (
          <Stack key={block.key} gap="xs">
            <Text
              ff="monospace"
              fw={400}
              style={{
                color: titleColor,
                overflowWrap: 'anywhere',
                fontSize: '13px',
                lineHeight: 1.68,
              }}
            >
              {block.title}
            </Text>
            <Box pl="sm">
              <Stack gap={4}>
                {block.lines.map((line, index) => (
                  <Text
                    key={`${block.key}:${index}`}
                    ff="monospace"
                    style={{
                      color: line.kind === 'added' ? 'var(--schema-diff-added)' : 'var(--schema-diff-removed)',
                      overflowWrap: 'anywhere',
                      fontSize: '13px',
                      lineHeight: 1.68,
                    }}
                  >
                    {line.kind === 'added' ? '+' : '-'} {line.text}
                  </Text>
                ))}
              </Stack>
            </Box>
          </Stack>
        )
      })}
    </Stack>
  )
}

function SchemaContentInset({ children }: { children: ReactNode }) {
  return (
    <Box px={{ base: 0, sm: 'md' }}>
      {children}
    </Box>
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

function formatPermifyHost(permifyUrl: string) {
  const trimmedUrl = permifyUrl.trim()
  const normalizedUrl = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `http://${trimmedUrl}`

  try {
    const host = new URL(normalizedUrl).host

    if (host) {
      return host
    }
  } catch {
    // Fall back to a best-effort host-like label for malformed config values.
  }

  return trimmedUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
}

function SidebarContextHint({ permifyUrl }: { permifyUrl: string }) {
  const host = formatPermifyHost(permifyUrl)
  const { colorScheme } = useMantineColorScheme()

  return (
    <Text
      size="xs"
      c={colorScheme === 'dark' ? 'dark.2' : 'gray.5'}
      truncate="end"
      display="block"
      w="100%"
      title={host}
    >
      {host}
    </Text>
  )
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

  if (loading) return <Loader m="xl" />
  if (error) return <ApiErrorAlert error={error} m="xl" />

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
    <Box maw={880} px={{ base: 'md', sm: 'xl' }} py={{ base: 'md', sm: 'xl' }}>
      <Stack gap="xl">
        <Grid gutter="sm" align="stretch">
          <Grid.Col span={{ base: 12, sm: 'auto' }}>
            <Box maw={540}>
            <Combobox
              store={combobox}
              onOptionSubmit={(value) => {
                if (value === selected) {
                  combobox.closeDropdown()
                  return
                }
                setSelected(value)
                loadSchema(value)
                combobox.closeDropdown()
              }}
              position="bottom-start"
              shadow="md"
              width="target"
            >
              <Combobox.Target targetType="button">
                <InputBase
                  component="button"
                  type="button"
                  pointer
                  multiline
                  radius="md"
                  size="md"
                  w="100%"
                  onClick={() => combobox.toggleDropdown()}
                  rightSection={<IconChevronDown size={16} stroke={1.75} color="var(--mantine-color-dimmed)" />}
                  rightSectionPointerEvents="none"
                >
                  <Stack gap={0} align="flex-start">
                    <Text component="span" fw={500}>
                      {selected}
                    </Text>
                    {selectedSchema?.created_at && <Text size="xs" c="dimmed">{fmtDate(selectedSchema.created_at)}</Text>}
                  </Stack>
                </InputBase>
              </Combobox.Target>
              <Combobox.Dropdown>
                <ScrollArea.Autosize mah={260} type="scroll" offsetScrollbars>
                  <Combobox.Options>
                    {schemas.map((schema) => (
                      <Combobox.Option
                        key={schema.version}
                        value={schema.version}
                        style={schema.version === selected ? { backgroundColor: 'var(--mantine-primary-color-light)' } : undefined}
                      >
                        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
                          <Stack gap={0} style={{ minWidth: 0 }}>
                            <Text size="sm">{schema.version}</Text>
                            <Text size="xs" c="dimmed">{fmtDate(schema.created_at)}</Text>
                          </Stack>
                          {schema.version === selected && <Text size="xs" c="primary" fw={500}>Selected</Text>}
                        </Group>
                      </Combobox.Option>
                    ))}
                  </Combobox.Options>
                </ScrollArea.Autosize>
              </Combobox.Dropdown>
            </Combobox>
            </Box>
          </Grid.Col>

          {canCompare && (
            <Grid.Col span={{ base: 12, sm: 'content' }}>
              <Button
                variant="default"
                radius="md"
                h="100%"
                w={{ base: '100%', sm: 340 }}
                leftSection={compareBlocks ? undefined : <IconLayersDifference size={18} />}
                loading={compareLoading}
                disabled={schemaLoading}
                onClick={toggleCompare}
              >
                {compareBlocks ? 'Back to schema' : 'Compare with previous version'}
              </Button>
            </Grid.Col>
          )}
        </Grid>

        {compareError && <ApiErrorAlert error={compareError} />}

        {schemaLoading || compareLoading ? (
          <Loader mt="md" />
        ) : compareBlocks ? (
          <SchemaContentInset>
            <SchemaDiffView blocks={compareBlocks} emptyLabel="No changes relative to previous." />
          </SchemaContentInset>
        ) : (
          <SchemaContentInset>
            <SchemaHighlight code={generateSchemaText(entities)} />
          </SchemaContentInset>
        )}
      </Stack>
    </Box>
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
  { value: 'all', label: 'All records' },
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
  const hasValue = value.trim().length > 0

  return (
    <Grid.Col span={span}>
      <TextInput
        label={label}
        labelProps={hasValue ? undefined : { c: 'dimmed' }}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Grid.Col>
  )
}

function TuplesScreen({ api }: { api: ApiClient }) {
  const isNarrowViewport = useMediaQuery('(max-width: 48em)')
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
    appliedFilter?.snapToken ? { label: 'Snap Token', value: appliedFilter.snapToken } : null,
    appliedFilter?.entityType ? { label: 'Entity Type', value: appliedFilter.entityType } : null,
    appliedFilter?.entityIds[0] ? { label: 'Entity ID', value: appliedFilter.entityIds[0] } : null,
    appliedFilter?.relation ? { label: 'Relation', value: appliedFilter.relation } : null,
    appliedFilter?.subjectType ? { label: 'Subject Type', value: appliedFilter.subjectType } : null,
    appliedFilter?.subjectIds[0] ? { label: 'Subject ID', value: appliedFilter.subjectIds[0] } : null,
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
    <Table verticalSpacing="xs" horizontalSpacing="sm" stickyHeader>
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
            <Table.Td><Text size="sm">{tuple.entity.type}</Text></Table.Td>
            <Table.Td><Text ff="monospace" size="sm">{tuple.entity.id}</Text></Table.Td>
            <Table.Td><Text ff="monospace" size="sm">{tuple.relation}</Text></Table.Td>
            <Table.Td><Text size="sm">{tuple.subject.type}</Text></Table.Td>
            <Table.Td><Text ff="monospace" size="sm">{tuple.subject.id}</Text></Table.Td>
            <Table.Td><Text size="sm" c="dimmed">{tuple.subject.relation || '—'}</Text></Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  )

  return (
    <Box maw={1120} px={{ base: 'md', sm: 'xl' }} py={{ base: 'md', sm: 'xl' }}>
      <Stack gap={loaded && !filtersExpanded ? 'lg' : 'xl'}>
        <Card withBorder p="md">
          <Stack gap={filtersExpanded ? 'md' : 0}>
            <Group justify="space-between" align="center" wrap="nowrap">
              {filtersExpanded ? (
                <Text size="sm" fw={500}>Filters</Text>
              ) : (
                <Group gap="md" align="center" style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={500}>Filters</Text>
                  {activeFilterItems.length > 0 ? (
                    <Pill.Group style={{ alignItems: 'center' }}>
                      {activeFilterItems.map((item) => (
                        <Pill key={`${item.label}:${item.value}`} size="sm">
                          {item.label}: {item.value}
                        </Pill>
                      ))}
                    </Pill.Group>
                  ) : (
                    <Text size="sm" c="dimmed">All relationships</Text>
                  )}
                </Group>
              )}
              {loaded && (
                <Button variant="default" size="xs" onClick={() => setFiltersExpanded((current) => !current)}>
                  {filtersExpanded ? 'Hide' : 'Edit filters'}
                </Button>
              )}
            </Group>
            {filtersExpanded && (
              <>
                <Grid gutter="md">
                  <FilterInput label="Entity Type" placeholder="any" span={{ base: 12, md: 6, lg: 4 }} value={filters.entityType} onChange={(value) => setFilter('entityType', value)} />
                  <FilterInput label="Entity ID" placeholder="any" span={{ base: 12, md: 6, lg: 4 }} value={filters.entityId} onChange={(value) => setFilter('entityId', value)} />
                  <FilterInput label="Relation" placeholder="any" span={{ base: 12, md: 6, lg: 4 }} value={filters.relation} onChange={(value) => setFilter('relation', value)} />
                  <FilterInput label="Subject Type" placeholder="any" span={{ base: 12, md: 6, lg: 4 }} value={filters.subjectType} onChange={(value) => setFilter('subjectType', value)} />
                  <FilterInput label="Subject ID" placeholder="any" span={{ base: 12, md: 6, lg: 4 }} value={filters.subjectId} onChange={(value) => setFilter('subjectId', value)} />
                  <FilterInput label="Snap Token" placeholder="latest" span={{ base: 12, md: 6, lg: 4 }} value={filters.snapToken} onChange={(value) => setFilter('snapToken', value)} />
                  <Grid.Col span={{ base: 12, md: 6, lg: 4 }}>
                    <Select
                      label="Page Size"
                      data={RELATIONSHIPS_PAGE_SIZE_OPTIONS}
                      value={filters.pageSize}
                      onChange={(value) => setFilter('pageSize', value ?? DEFAULT_RELATIONSHIPS_PAGE_SIZE)}
                      allowDeselect={false}
                    />
                  </Grid.Col>
                </Grid>
                <Group gap="sm">
                  <Button onClick={fetchTuples} loading={loading}>Load</Button>
                  <Button variant="default" onClick={reset}>Reset</Button>
                </Group>
              </>
            )}
          </Stack>
        </Card>

        {error && <ApiErrorAlert error={error} />}

        {!loaded && !error && (
          <Text size="sm" c="dimmed">
            Set filters and click Load to explore relationships.
          </Text>
        )}

        {loaded && (
          <Stack gap="md">
            {isNarrowViewport ? (
              <Table.ScrollContainer minWidth={900} type="native">
                {tuplesTable}
              </Table.ScrollContainer>
            ) : (
              tuplesTable
            )}
            {continuousToken && (
              <Group justify="flex-end">
                <Button variant="default" onClick={loadMore} loading={loadingMore}>Load more</Button>
              </Group>
            )}
          </Stack>
        )}
      </Stack>
    </Box>
  )
}

function req(value: string, validated: boolean) {
  return validated && !value.trim() ? 'Required' : undefined
}

function ActionCard({
  actionLabel,
  children,
  description,
  loading,
  onAction,
}: {
  actionLabel: string
  children: ReactNode
  description: string
  loading: boolean
  onAction: () => void
}) {
  return (
    <Card withBorder>
      <Stack>
        <Text size="md" fw={500} c="dimmed">{description}</Text>
        {children}
        <Button onClick={onAction} loading={loading} w="fit-content">
          {actionLabel}
        </Button>
      </Stack>
    </Card>
  )
}

function BadgeListResult({ countLabel, values }: { countLabel: string; values: string[] }) {
  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        {values.length} {countLabel}
      </Text>
      <Group gap="xs">
        {values.map((value) => (
          <Badge key={value} variant="light">
            {value}
          </Badge>
        ))}
      </Group>
    </Stack>
  )
}

function ResourceCheckTab({ api }: { api: ApiClient }) {
  const [entityType, setEntityType] = useState('')
  const [entityId, setEntityId] = useState('')
  const [permission, setPermission] = useState('')
  const [subjectType, setSubjectType] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [subjectRelation, setSubjectRelation] = useState('')
  const [snapToken, setSnapToken] = useState('')
  const [result, setResult] = useState<CheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [validated, setValidated] = useState(false)

  async function check() {
    setValidated(true)
    if (!entityType.trim() || !entityId.trim() || !permission.trim() || !subjectType.trim() || !subjectId.trim()) return

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      setResult(await api.checkPermission({
        entityType,
        entityId,
        permission,
        subjectType,
        subjectId,
        subjectRelation,
        snapToken: snapToken.trim(),
      }))
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error('unknown error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Stack>
      <ActionCard
        actionLabel="Check Access"
        description="Check whether a subject has a permission on a specific entity."
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
      </ActionCard>
      {error && <ApiErrorAlert error={error} />}
      {result && (
        <Card withBorder>
          <Group align="center">
            <Badge size="md" color={result.can === 'CHECK_RESULT_ALLOWED' ? 'green' : 'red'} variant="light">
              {result.can === 'CHECK_RESULT_ALLOWED' ? 'Allowed' : 'Denied'}
            </Badge>
            <Text size="sm" c="dimmed">checks performed: {result.metadata.check_count}</Text>
          </Group>
        </Card>
      )}
    </Stack>
  )
}

function LookupEntityTab({ api }: { api: ApiClient }) {
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
    <Stack>
      <ActionCard
        actionLabel="Lookup Entities"
        description="Find which entities a subject can access with a given permission."
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
      </ActionCard>
      {error && <ApiErrorAlert error={error} />}
      {loaded && <BadgeListResult countLabel="entities found" values={entityIds} />}
      {continuousToken && (
        <Group justify="flex-end">
          <Button variant="default" onClick={loadMore} loading={loadingMore}>Load more</Button>
        </Group>
      )}
    </Stack>
  )
}

function LookupSubjectTab({ api }: { api: ApiClient }) {
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
    <Stack>
      <ActionCard
        actionLabel="Lookup Subjects"
        description="Find which subjects have a given permission on an entity."
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
      </ActionCard>
      {error && <ApiErrorAlert error={error} />}
      {loaded && <BadgeListResult countLabel="subjects found" values={subjectIds} />}
      {continuousToken && (
        <Group justify="flex-end">
          <Button variant="default" onClick={loadMore} loading={loadingMore}>Load more</Button>
        </Group>
      )}
    </Stack>
  )
}

function CheckScreen({ api }: { api: ApiClient }) {
  return (
    <Box maw={1040} px={{ base: 'md', sm: 'xl' }} py={{ base: 'md', sm: 'xl' }}>
      <Tabs defaultValue="check">
        <Tabs.List>
          <Tabs.Tab value="check">Resource Check</Tabs.Tab>
          <Tabs.Tab value="lookup">Entity Lookup</Tabs.Tab>
          <Tabs.Tab value="subject">Subject Lookup</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="check" pt="xl">
          <ResourceCheckTab api={api} />
        </Tabs.Panel>
        <Tabs.Panel value="lookup" pt="xl">
          <LookupEntityTab api={api} />
        </Tabs.Panel>
        <Tabs.Panel value="subject" pt="xl">
          <LookupSubjectTab api={api} />
        </Tabs.Panel>
      </Tabs>
    </Box>
  )
}

function ApiErrorAlert({ error, m }: { error: Error; m?: string }) {
  if (error instanceof ApiError) {
    const bodyJson = error.body === undefined ? null : JSON.stringify(error.body, null, 2)

    return (
      <Alert
        color="red"
        variant="outline"
        title={<Text inherit ff="monospace">{error.status} {error.path}</Text>}
        styles={{
          label: {
            overflow: 'visible',
            textOverflow: 'unset',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
          },
        }}
        m={m}
      >
        {bodyJson ? (
          <Text
            component="pre"
            size="sm"
            ff="monospace"
            c="dimmed"
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {bodyJson}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">{error.message}</Text>
        )}
      </Alert>
    )
  }

  return <Alert color="red" variant="outline" m={m}>{error.message}</Alert>
}

export function App() {
  const [page, setPage] = useState<Page>(() => parsePage(new URLSearchParams(window.location.search).get('page')))
  const [schemaScreenKey, setSchemaScreenKey] = useState(0)
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
      setPage(parsePage(new URLSearchParams(window.location.search).get('page')))
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  function navigate(nextPage: Page) {
    setPage(nextPage)
    setMobileNavbarOpened(false)
    window.history.pushState(null, '', nextPage === 'schema' ? '/' : `/?page=${nextPage}`)
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
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={mobileNavbarOpened} onClick={() => setMobileNavbarOpened((current) => !current)} size="sm" aria-label="Toggle navigation" />
            <UnstyledButton onClick={navigateHome}>
              <Text fw={600}>Permify UI</Text>
            </UnstyledButton>
          </Group>
          <ThemeToggle />
        </Group>
      </AppShell.Header>

      <AppShell.Navbar>
        <AppShell.Section px="lg" pt="xl" pb="md" mb="md">
          <Stack gap={4}>
            <Group justify="space-between" wrap="nowrap">
              <UnstyledButton onClick={navigateHome}>
                <Title order={4} fw={600}>Permify UI</Title>
              </UnstyledButton>
              <ThemeToggle />
            </Group>
            <SidebarContextHint permifyUrl={permifyUrl} />
          </Stack>
        </AppShell.Section>

        <AppShell.Section grow component="nav">
          {([
            ['schema', 'Schemas', IconBraces],
            ['relations', 'Relations', IconArrowsExchange],
            ['check', 'Check access', IconLockCheck],
          ] as const).map(([itemPage, label, Icon]) => (
            <NavLink
              key={itemPage}
              component="a"
              href="#"
              active={page === itemPage}
              leftSection={<Icon size={18} />}
              label={label}
              onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
                event.preventDefault()
                navigate(itemPage)
              }}
            />
          ))}
        </AppShell.Section>

        {authEnabled && (
          <AppShell.Section px="lg" py="md" mt="md">
            <Group gap="xs" wrap="nowrap">
              <Text size="xs" c="dimmed" truncate="end" flex={1}>
                {email}
              </Text>
              <Tooltip label="Logout" position="top">
                <Box component="form" action="/auth/logout" method="post">
                  <ActionIcon type="submit" variant="subtle" color="gray" size="sm" aria-label="Logout">
                    <IconLogout size={16} />
                  </ActionIcon>
                </Box>
              </Tooltip>
            </Group>
          </AppShell.Section>
        )}
      </AppShell.Navbar>

      <AppShell.Main>
        {page === 'schema' && <SchemaScreen key={schemaScreenKey} api={api} />}
        {page === 'relations' && <TuplesScreen api={api} />}
        {page === 'check' && <CheckScreen api={api} />}
      </AppShell.Main>
    </AppShell>
  )
}
