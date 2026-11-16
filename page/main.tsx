/** @jsxImportSource solid-js */
/**
 * The desk page: one session's desk (`/sessions/<id>`; at `/`, the list of desks), its open entries as a flat list,
 * and an entry view (`/sessions/<id>/questions/<entry id>`) with its parent, follow-ups, a draft box and Next.
 * Every route is inside the shell's layout, which reads the desk from the URL: moving to another desk, like every
 * link here, stays on the page, and the view and the drafts follow the route.
 * Drafts live in the browser until Submit (all of them, one message per session), ⌘↵ (the same, then Next) or Send now (one, steering).
 */

import { MetaProvider } from "@solidjs/meta";
import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import { patterns } from "../src/api/routes";
import { EntryView } from "./pages/entry";
import { List } from "./pages/list";
import { Shell } from "./shell";

const App = () => (
	<MetaProvider>
		<Router>
			<Route path="/" component={Shell}>
				<Route path={[...patterns.list]} component={List} />
				<Route path={patterns.entry} component={EntryView} />
			</Route>
		</Router>
	</MetaProvider>
);

render(() => <App />, document.body);
