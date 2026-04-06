import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider, createTheme, Badge, Card, Combobox, Input, NavLink, Pill, SegmentedControl, Table, Textarea, localStorageColorSchemeManager, virtualColor, type CSSVariablesResolver } from '@mantine/core'
import '@mantine/core/styles.css'
import { App } from './App'

const colorSchemeManager = localStorageColorSchemeManager({
  key: 'permify-ui-color-scheme',
})

const syntaxVariablesLight = {
  '--syntax-entity-keyword': '#7F77DD',
  '--syntax-relation-keyword': '#378ADD',
  '--syntax-permission-keyword': '#BA7517',
  '--syntax-operator-keyword': '#A32D2D',
  '--syntax-reference-type': '#888780',
  '--syntax-punct': '#888780',
  '--schema-diff-added': 'var(--mantine-color-green-7)',
  '--schema-diff-removed': 'var(--mantine-color-red-7)',
}

const syntaxVariablesDark = {
  '--syntax-entity-keyword': '#B8A8FF',
  '--syntax-relation-keyword': '#74C0FC',
  '--syntax-permission-keyword': '#FFD166',
  '--syntax-operator-keyword': '#FF8787',
  '--syntax-reference-type': '#ADB5BD',
  '--syntax-punct': '#ADB5BD',
  '--schema-diff-added': 'var(--mantine-color-green-4)',
  '--schema-diff-removed': 'var(--mantine-color-red-4)',
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
        radius: 'xl',
        ff: 'monospace',
        fw: 400,
      },
      vars: (_theme, props) => {
        if (props.size === 'sm') {
          return { root: { '--badge-fz': 'var(--mantine-font-size-sm)', '--badge-height': '24px' } }
        }
        return { root: {} }
      },
    }),
    Card: Card.extend({
      styles: {
        root: {
          backgroundColor: 'var(--app-surface-bg)',
        },
      },
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
    Input: Input.extend({
      styles: {
        input: {
          backgroundColor: 'var(--app-surface-bg)',
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
          '--nl-bg': 'var(--mantine-primary-color-light)',
          '--nl-color': 'var(--mantine-color-text)',
          '--nl-hover': 'var(--mantine-color-default-hover)',
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
      },
    }),
    Textarea: Textarea.extend({
      styles: {
        input: {
          backgroundColor: 'var(--app-surface-bg)',
          fontFamily: 'var(--mantine-font-family-monospace)',
          fontSize: 'var(--mantine-font-size-sm)',
        },
      },
    }),
    Table: Table.extend({
      defaultProps: {
        highlightOnHover: true,
        verticalSpacing: 'sm',
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
    '--app-pill-bg': 'var(--mantine-color-gray-1)',
    '--app-pill-color': 'var(--mantine-color-black)',
  },
  dark: {
    ...syntaxVariablesDark,
    '--app-pill-bg': 'var(--mantine-color-dark-6)',
    '--app-pill-color': 'var(--mantine-color-dark-0)',
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      colorSchemeManager={colorSchemeManager}
      defaultColorScheme="light"
    >
      <App />
    </MantineProvider>
  </StrictMode>
)
