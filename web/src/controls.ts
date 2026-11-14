import { createContext, useContext } from "react";

/** Stop / resume live in the app shell (confirm sheets, undo toast); pages call them through this. */
export interface ControlsApi { requestStop: () => void; requestResume: () => void }
export const Controls = createContext<ControlsApi>({ requestStop: () => {}, requestResume: () => {} });
export const useControls = (): ControlsApi => useContext(Controls);
