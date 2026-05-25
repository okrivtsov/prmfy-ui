import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider, createTheme, Badge, Combobox, NavLink, Pill, SegmentedControl, Table, Textarea, localStorageColorSchemeManager, virtualColor, type CSSVariablesResolver } from '@mantine/core'
import '@mantine/core/styles.css'
import { App } from './App'

const colorSchemeManager = localStorageColorSchemeManager({
  key: 'permify-ui-color-scheme',
})

const syntaxVariablesLight = {
  '--syntax-entity-keyword': 'var(--mantine-color-violet-7)',
  '--syntax-relation-keyword': 'var(--mantine-color-blue-7)',
  '--syntax-permission-keyword': 'var(--mantine-color-orange-7)',
  '--syntax-operator-keyword': 'var(--mantine-color-red-7)',
  '--syntax-reference-type': 'var(--mantine-color-gray-6)',
  '--syntax-punct': 'var(--mantine-color-gray-6)',
  '--schema-diff-added': 'var(--mantine-color-green-7)',
  '--schema-diff-removed': 'var(--mantine-color-red-7)',
}

const syntaxVariablesDark = {
  '--syntax-entity-keyword': 'var(--mantine-color-violet-4)',
  '--syntax-relation-keyword': 'var(--mantine-color-blue-4)',
  '--syntax-permission-keyword': 'var(--mantine-color-yellow-4)',
  '--syntax-operator-keyword': 'var(--mantine-color-red-4)',
  '--syntax-reference-type': 'var(--mantine-color-gray-5)',
  '--syntax-punct': 'var(--mantine-color-gray-5)',
  '--schema-diff-added': 'var(--mantine-color-green-4)',
  '--schema-diff-removed': 'var(--mantine-color-red-4)',
}

const checkResultVariablesLight = {
  '--check-result-allowed-bg': '#f6faf7',
  '--check-result-allowed-border': '#dde6df',
  '--check-result-allowed-status': '#2f9e44',
  '--check-result-denied-bg': '#fdf6f6',
  '--check-result-denied-border': '#ecdcdc',
  '--check-result-denied-status': '#e03131',
  '--check-result-error-bg': '#fdf8f0',
  '--check-result-error-border': '#f0e4cf',
  '--check-result-error-status': '#d9730d',
  '--check-result-trace-label': '#6d726d',
  '--check-result-trace-path': '#373a37',
  '--check-result-trace-path-dimmed': '#7a7f7a',
}

const checkResultVariablesDark = {
  '--check-result-allowed-bg': '#1f2620',
  '--check-result-allowed-border': '#36413a',
  '--check-result-allowed-status': '#51cf66',
  '--check-result-denied-bg': '#2a2020',
  '--check-result-denied-border': '#43383a',
  '--check-result-denied-status': '#ff6b6b',
  '--check-result-error-bg': '#292419',
  '--check-result-error-border': '#44402f',
  '--check-result-error-status': '#ffa94d',
  '--check-result-trace-label': '#9a9f9a',
  '--check-result-trace-path': '#d8dbd8',
  '--check-result-trace-path-dimmed': '#7f847f',
}

const theme = createTheme({
  primaryColor: 'primary',
  primaryShade: { light: 6, dark: 8 },
  cursorType: 'pointer',
  defaultRadius: 'sm',
  fontFamily: 'Inter, sans-serif',
  fontFamilyMonospace: 'JetBrains Mono, monospace',
  headings: {
    fontFamily: 'Inter, sans-serif',
    fontWeight: '500',
  },
  colors: {
    primary: virtualColor({
      name: 'primary',
      light: 'blue',
      dark: 'cyan',
    }),
  },
  components: {
    Badge: Badge.extend({
      defaultProps: {
        tt: 'none',
        radius: 'sm',
        fw: 500,
      },
      vars: () => ({
        root: {
          '--badge-fz': 'var(--mantine-font-size-sm)',
          '--badge-height': '26px',
          '--badge-padding-x': 'var(--mantine-spacing-sm)',
        },
      }),
    }),
    Combobox: Combobox.extend({
      styles: {
        dropdown: {
          backgroundColor: 'var(--app-surface-bg)',
        },
        option: {
          '&:hover': {
            backgroundColor: 'var(--app-surface-hover)',
          },
        },
      },
    }),
    NavLink: NavLink.extend({
      styles: {
        root: {
          fontSize: 'var(--mantine-font-size-sm)',
          color: 'var(--mantine-color-text)',
          paddingLeft: 'var(--mantine-spacing-lg)',
          paddingRight: 'var(--mantine-spacing-lg)',
          '--nl-bg': 'transparent',
          '--nl-color': 'var(--mantine-color-text)',
          '--nl-hover': 'var(--mantine-color-default-hover)',
          '&[data-active]': {
            fontWeight: 500,
          },
        },
      },
    }),
    Pill: Pill.extend({
      styles: {
        root: {
          backgroundColor: 'var(--app-pill-bg)',
          color: 'var(--app-pill-color)',
        },
      },
    }),
    SegmentedControl: SegmentedControl.extend({
      defaultProps: {
        size: 'xs',
        radius: 'sm',
        withItemsBorders: false,
      },
      vars: () => ({
        root: {
          '--sc-shadow': 'none',
          '--sc-color': 'var(--mantine-color-default)',
        },
      }),
      styles: {
        root: {
          backgroundColor: 'transparent',
          padding: 0,
        },
        indicator: {
          backgroundColor: 'var(--mantine-color-default)',
          border: '1px solid var(--mantine-color-default-border)',
        },
      },
    }),
    Textarea: Textarea.extend({
      styles: {
        input: {
          fontFamily: 'var(--mantine-font-family-monospace)',
          fontSize: 'var(--mantine-font-size-sm)',
        },
      },
    }),
    Table: Table.extend({
      defaultProps: {
        highlightOnHover: true,
        verticalSpacing: 'xs',
        horizontalSpacing: 'md',
        tabularNums: true,
      },
    }),
  },
})

const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    '--app-surface-bg': 'var(--mantine-color-body)',
    '--app-surface-hover': 'var(--mantine-color-default-hover)',
  },
  light: {
    ...syntaxVariablesLight,
    ...checkResultVariablesLight,
    '--app-pill-bg': 'var(--mantine-color-gray-1)',
    '--app-pill-color': 'var(--mantine-color-black)',
  },
  dark: {
    ...syntaxVariablesDark,
    ...checkResultVariablesDark,
    '--app-pill-bg': 'var(--mantine-color-dark-6)',
    '--app-pill-color': 'var(--mantine-color-dark-0)',
  },
})

class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI render error', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          <strong>UI error</strong>
          {'\n\n'}
          {this.state.error.message}
        </div>
      )
    }

    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        colorSchemeManager={colorSchemeManager}
        defaultColorScheme="light"
      >
        <App />
      </MantineProvider>
    </RootErrorBoundary>
  </StrictMode>
)
