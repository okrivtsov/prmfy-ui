import { Box, Group, Paper, Stack, Text } from '@mantine/core'
import {
  IconAlertTriangleFilled,
  IconCircleCheckFilled,
  IconCircleXFilled,
} from '@tabler/icons-react'
import classes from './CheckResult.module.css'

export interface ExpandLeafSubject {
  type: string
  id: string
  relation: string
}

export interface ExpandTreeNode {
  entity: { type: string; id: string }
  permission: string
  expand?: { operation: string; children: ExpandTreeNode[] }
  leaf?: {
    subjects?: { subjects: ExpandLeafSubject[] }
    values?: unknown
  }
}

export type CheckedSubject = {
  type: string
  id: string
  relation?: string
}

export type CheckResultProps = {
  m?: string | number
} & (
  | {
      status: 'allowed' | 'denied'
      expandTree: ExpandTreeNode | null
      checkedSubject: CheckedSubject
      emptyMessage?: string
    }
  | { status: 'error'; httpCode: number; endpoint: string; body: unknown }
)

export function checkResultErrorProps(error: Error): Extract<CheckResultProps, { status: 'error' }> {
  if (
    'status' in error
    && typeof error.status === 'number'
    && 'path' in error
    && typeof error.path === 'string'
  ) {
    const apiError = error as Error & { status: number; path: string; body?: unknown }
    return {
      status: 'error',
      httpCode: apiError.status,
      endpoint: apiError.path,
      body: apiError.body ?? { message: apiError.message },
    }
  }

  return { status: 'error', httpCode: 0, endpoint: 'Error', body: { message: error.message } }
}

const PATH_SEP = ' -> '

function entityRef(entity: { type: string; id: string }) {
  return `${entity.type}:${entity.id}`
}

function relationRef(permission: string) {
  return `#${permission}`
}

function formatExpandSubject(subject: ExpandLeafSubject) {
  const base = `${subject.type}:${subject.id}`
  return subject.relation ? `${base}#${subject.relation}` : base
}

function subjectMatches(subject: ExpandLeafSubject, checked: CheckedSubject) {
  if (subject.type !== checked.type || subject.id !== checked.id) return false
  return (subject.relation ?? '') === (checked.relation ?? '')
}

function expandOperationLabel(operation: string): string | null {
  switch (operation) {
    case 'OPERATION_INTERSECTION':
      return 'All of'
    case 'OPERATION_UNION':
      return 'Any of'
    case 'OPERATION_EXCLUSION':
      return 'Except'
    default:
      return null
  }
}

function entityChanged(
  left: { type: string; id: string },
  right: { type: string; id: string },
) {
  return left.type !== right.type || left.id !== right.id
}

/** Drop pass-through wrappers: single child with the same entity and permission. */
function simplifyNode(node: ExpandTreeNode): ExpandTreeNode {
  let current = node

  while (current.expand?.children.length === 1) {
    const child = current.expand.children[0]
    const sameEntity =
      child.entity.type === current.entity.type && child.entity.id === current.entity.id
    const samePermission = child.permission === current.permission

    if (!sameEntity || !samePermission) break
    current = child
  }

  return current
}

function hopText(parent: ExpandTreeNode, child: ExpandTreeNode) {
  return `${entityRef(parent.entity)}${PATH_SEP}${relationRef(parent.permission)}${PATH_SEP}${entityRef(child.entity)}`
}

/** Single-child chain ending in a leaf — render as one path line. */
function collectLinearChain(node: ExpandTreeNode): ExpandTreeNode[] | null {
  const chain: ExpandTreeNode[] = []
  let current = simplifyNode(node)

  while (true) {
    chain.push(current)
    if (current.leaf) return chain

    const children = current.expand?.children ?? []
    if (children.length !== 1) return null
    current = simplifyNode(children[0])
  }
}

function formatLinearChain(
  chain: ExpandTreeNode[],
  checkedSubject: CheckedSubject,
  pathPrefix = '',
): { text: string; matched: boolean }[] {
  const leaf = chain[chain.length - 1]
  if (!leaf.leaf) return []

  let path = pathPrefix || entityRef(chain[0].entity)
  for (let i = 1; i < chain.length; i++) {
    path += `${PATH_SEP}${relationRef(chain[i - 1].permission)}${PATH_SEP}${entityRef(chain[i].entity)}`
  }

  const subjects = leaf.leaf.subjects?.subjects ?? []
  if (subjects.length > 0) {
    return subjects.map((subject) => ({
      text: `${path}${PATH_SEP}${relationRef(leaf.permission)}${PATH_SEP}${formatExpandSubject(subject)}`,
      matched: subjectMatches(subject, checkedSubject),
    }))
  }

  if (leaf.leaf.values != null) {
    return [{
      text: `${path}${PATH_SEP}${relationRef(leaf.permission)}${PATH_SEP}${JSON.stringify(leaf.leaf.values)}`,
      matched: false,
    }]
  }

  return [{
    text: `${path}${PATH_SEP}${relationRef(leaf.permission)}${PATH_SEP}(empty)`,
    matched: false,
  }]
}

function hasExpandContent(node: ExpandTreeNode): boolean {
  const current = simplifyNode(node)

  if (current.leaf) {
    const subjects = current.leaf.subjects?.subjects ?? []
    return subjects.length > 0 || current.leaf.values != null
  }

  return (current.expand?.children ?? []).some(hasExpandContent)
}

function PathText({ text }: { text: string }) {
  const parts = text.split(PATH_SEP)

  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && <span className={classes.pathSep}>{PATH_SEP}</span>}
          {part}
        </span>
      ))}
    </>
  )
}

function LeafRow({ text, matched }: { text: string; matched: boolean }) {
  return (
    <Box className={matched ? classes.pathRow : classes.pathRowDimmed}>
      <span className={classes.pathText}><PathText text={text} /></span>
    </Box>
  )
}

function formatLeafRows(
  node: ExpandTreeNode,
  checkedSubject: CheckedSubject,
  pathPrefix: string,
): { text: string; matched: boolean }[] {
  const subjects = node.leaf?.subjects?.subjects ?? []

  if (subjects.length > 0) {
    const base = pathPrefix || entityRef(node.entity)
    return subjects.map((subject) => ({
      text: `${base}${PATH_SEP}${relationRef(node.permission)}${PATH_SEP}${formatExpandSubject(subject)}`,
      matched: subjectMatches(subject, checkedSubject),
    }))
  }

  if (node.leaf?.values != null) {
    const base = pathPrefix || entityRef(node.entity)
    return [{
      text: `${base}${PATH_SEP}${relationRef(node.permission)}${PATH_SEP}${JSON.stringify(node.leaf.values)}`,
      matched: false,
    }]
  }

  const base = pathPrefix || entityRef(node.entity)
  return [{
    text: `${base}${PATH_SEP}${relationRef(node.permission)}${PATH_SEP}(empty)`,
    matched: false,
  }]
}

function ExpandTreeNodeView({
  node,
  checkedSubject,
  pathPrefix = '',
}: {
  node: ExpandTreeNode
  checkedSubject: CheckedSubject
  pathPrefix?: string
}) {
  const current = simplifyNode(node)

  if (current.leaf) {
    const rows = formatLeafRows(current, checkedSubject, pathPrefix)
    return (
      <Box className={classes.pathRows}>
        {rows.map((row, index) => (
          <LeafRow key={index} matched={row.matched} text={row.text} />
        ))}
      </Box>
    )
  }

  const linearChain = collectLinearChain(current)
  if (linearChain && linearChain.length > 1 && linearChain[linearChain.length - 1]?.leaf) {
    const rows = formatLinearChain(linearChain, checkedSubject, pathPrefix)
    return (
      <Box className={classes.pathRows}>
        {rows.map((row, index) => (
          <LeafRow key={index} matched={row.matched} text={row.text} />
        ))}
      </Box>
    )
  }

  const children = current.expand?.children ?? []
  if (children.length === 0) {
    return (
      <LeafRow
        matched={false}
        text={`${pathPrefix || entityRef(current.entity)}${PATH_SEP}${relationRef(current.permission)}${PATH_SEP}(no expansion)`}
      />
    )
  }

  if (children.length === 1) {
    const child = children[0]
    const nextPrefix = entityChanged(current.entity, child.entity)
      ? `${pathPrefix}${hopText(current, child)}`
      : pathPrefix

    return (
      <ExpandTreeNodeView
        node={child}
        checkedSubject={checkedSubject}
        pathPrefix={nextPrefix}
      />
    )
  }

  const opLabel = expandOperationLabel(current.expand!.operation)

  return (
    <Stack gap={4} className={classes.treeGroup}>
      {opLabel && (
        <Text size="xs" className={classes.treeOpLabel} mb={2}>
          {opLabel}
        </Text>
      )}
      <Stack gap={4} className={classes.treeChildren}>
        {children.map((child, index) => (
          <Box key={index} className={classes.treeChild}>
            <ExpandTreeNodeView node={child} checkedSubject={checkedSubject} />
          </Box>
        ))}
      </Stack>
    </Stack>
  )
}

function ExpandTreeView({
  tree,
  checkedSubject,
  emptyMessage,
}: {
  tree: ExpandTreeNode | null
  checkedSubject: CheckedSubject
  emptyMessage?: string
}) {
  if (!tree || !hasExpandContent(tree)) {
    if (emptyMessage) {
      return (
        <Text size="sm" className={classes.pathRow} mt="sm">
          {emptyMessage}
        </Text>
      )
    }

    return null
  }

  return (
    <Box className={classes.trace}>
      <ExpandTreeNodeView node={tree} checkedSubject={checkedSubject} />
    </Box>
  )
}

export function CheckResult(props: CheckResultProps) {
  if (props.status === 'error') {
    const { httpCode, endpoint, body, m } = props
    const title = httpCode > 0 ? `Error ${httpCode}` : 'Error'
    const showEndpoint = endpoint !== 'Error'

    return (
      <Paper m={m} className={classes.resultError}>
        <Group gap={7} className={classes.statusError} wrap="nowrap" align="flex-start">
          <IconAlertTriangleFilled size={19} color="currentColor" style={{ flex: 'none', marginTop: 1 }} />
          <Text fw={700} fz={15} c="inherit" component="span" style={{ overflowWrap: 'anywhere' }}>
            {showEndpoint ? `${title}: ${endpoint}` : title}
          </Text>
        </Group>

        <Box className={classes.trace}>
          <Box component="pre" className={classes.traceDetail}>
            {JSON.stringify(body, null, 2)}
          </Box>
        </Box>
      </Paper>
    )
  }

  const { status, expandTree, checkedSubject, emptyMessage, m } = props
  const allowed = status === 'allowed'

  return (
    <Paper
      m={m}
      className={allowed ? classes.resultAllowed : classes.resultDenied}
    >
      <Group gap={7} className={allowed ? classes.statusAllowed : classes.statusDenied}>
        {allowed ? (
          <IconCircleCheckFilled size={19} color="currentColor" />
        ) : (
          <IconCircleXFilled size={19} color="currentColor" />
        )}
        <Text fw={700} fz={15} c="inherit" component="span">
          {allowed ? 'Allowed' : 'Denied'}
        </Text>
      </Group>

      <ExpandTreeView
        tree={expandTree}
        checkedSubject={checkedSubject}
        emptyMessage={emptyMessage}
      />
    </Paper>
  )
}
