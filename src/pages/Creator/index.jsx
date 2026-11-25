import LabelEditor from '../../labels/components/LabelEditor.jsx';

// The stylesheets are imported by AppShell.jsx, which wraps every route -
// this page only mounts the editor.
export default function Creator() {
  return <LabelEditor />;
}
