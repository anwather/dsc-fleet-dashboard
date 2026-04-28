import { useEffect, useRef } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { configureMonacoYaml, type MonacoYamlOptions } from 'monaco-yaml';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import yamlWorker from 'monaco-yaml/yaml.worker?worker';
import { registerDscIntellisense } from '@/lib/dscIntellisense';

/**
 * Monaco editor wired up with monaco-yaml so users get DSC v3 schema
 * completion when authoring config YAML.
 *
 * The DSC v3 bundled document schema is shipped as a local asset under
 * `/schemas/dsc-v3-document.json` so we don't depend on aka.ms / GitHub
 * being reachable from the user's browser, and so monaco-yaml gets a
 * proper application/json content-type.
 *
 * On top of monaco-yaml's schema-driven validation we register a
 * context-aware completion + hover provider (see dscIntellisense.ts) that
 * suggests resource `type:` values from a curated catalog and the
 * properties accepted by each resource — the bundled schema does not
 * describe per-resource property bags so this layer is required for a
 * useful authoring experience.
 *
 * monaco-yaml requires a Web Worker — Vite's `?worker` import gives us one.
 */

let configured = false;

function configureOnce() {
  if (configured) return;
  configured = true;

  // Tell Monaco where to find workers.
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === 'yaml') return new yamlWorker();
      return new editorWorker();
    },
  };

  loader.config({ monaco });

  const options: MonacoYamlOptions = {
    enableSchemaRequest: true,
    hover: true,
    completion: true,
    validate: true,
    format: true,
    schemas: [
      {
        // Locally hosted copy of the DSC v3 bundled document schema.
        // The canonical URL is used as the schema's $id so $ref resolution
        // and "Go to schema" still work, but the actual fetch hits our
        // own static asset.
        uri: `${window.location.origin}/schemas/dsc-v3-document.json`,
        fileMatch: ['*'],
      },
    ],
  };
  configureMonacoYaml(monaco, options);

  registerDscIntellisense();
}

export interface MonacoYamlEditorProps {
  value: string;
  onChange: (next: string) => void;
  height?: string | number;
  readOnly?: boolean;
}

export function MonacoYamlEditor({
  value,
  onChange,
  height = '100%',
  readOnly,
}: MonacoYamlEditorProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    configureOnce();
  }, []);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  // Monaco picks up the doctype from theme; switch on dark mode
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  return (
    <div className="monaco-editor-container border rounded-md overflow-hidden">
      <Editor
        height={height}
        defaultLanguage="yaml"
        path="config.dsc.yaml"
        theme={dark ? 'vs-dark' : 'vs'}
        value={value}
        onChange={(v) => onChange(v ?? '')}
        onMount={handleMount}
        options={{
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          tabSize: 2,
          wordWrap: 'on',
          automaticLayout: true,
          readOnly,
        }}
      />
    </div>
  );
}
