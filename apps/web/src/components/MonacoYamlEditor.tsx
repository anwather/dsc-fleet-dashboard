import { useEffect, useRef } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { configureMonacoYaml, type MonacoYamlOptions } from 'monaco-yaml';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import yamlWorker from 'monaco-yaml/yaml.worker?worker';

/**
 * Monaco editor wired up with monaco-yaml so users get DSC v3 schema
 * completion when authoring config YAML.
 *
 * The DSC v3 bundled schema lives at:
 *   https://aka.ms/dsc/schemas/v3/bundled/config/document.json
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
        // Match any *.dsc.yaml or .yaml file the user is editing in this app.
        uri: 'https://aka.ms/dsc/schemas/v3/bundled/config/document.json',
        fileMatch: ['*'],
      },
    ],
  };
  configureMonacoYaml(monaco, options);
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
