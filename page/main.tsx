/** @jsxImportSource solid-js */
/**
 * The desk page: one session's desk (`/sessions/<id>`; at `/`, the list of desks), its open entries as a flat list,
 * and an entry view (`/sessions/<id>/questions/<entry id>`) with its parent, follow-ups, a draft box and Next.
 * Moving to another desk, like every link here, stays on the page: the view and the drafts follow the route.
 * Drafts live in the browser until Submit (all of them, one message per session), ⌘↵ (the same, then Next) or Send now (one, steering).
 */

import { MetaProvider, Title } from "@solidjs/meta";
import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import { patterns } from "../src/api/routes";
import { createDesk, DeskProvider } from "./desk";
import { EntryView } from "./pages/entry";
import { List } from "./pages/list";
import { deskName } from "./session";
import { Shell } from "./shell";

function App() {
	const desk = createDesk();
	const { state, mine } = desk.view;
	return (
		<DeskProvider desk={desk}>
			<MetaProvider>
				<Title>{`${mine().length ? `(${mine().length}) ` : ""}${state.view?.desk ? `${deskName(state.view.desk)} · ` : ""}Desk`}</Title>
				<Router root={Shell}>
					<Route path={[...patterns.list]} component={List} />
					<Route path={patterns.entry} component={EntryView} />
				</Router>
			</MetaProvider>
		</DeskProvider>
	);
}

render(() => <App />, document.body);
