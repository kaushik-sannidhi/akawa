import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
    apiKey: "AIzaSyA10gg4dmWR19i-5YmbTnkDFxvNt5ghdfY",
    authDomain: "uiuc-24fae.firebaseapp.com",
    databaseURL: "https://uiuc-24fae-default-rtdb.firebaseio.com",
    projectId: "uiuc-24fae",
    storageBucket: "uiuc-24fae.firebasestorage.app",
    messagingSenderId: "410939547913",
    appId: "1:410939547913:web:4e592b9288c76e6ca0f3d8",
    measurementId: "G-713MQXD177"
};


// Initialize Firebase only if it hasn't been initialized yet
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);
export default app;
