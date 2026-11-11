// FidelAI — Firebase Configuration
// Replace with your Firebase project credentials

const firebaseConfig = {
    apiKey: "AIzaSyD7kHbNv09Mg-aYfFXSMKrVdi_JqlOuQF4",
    authDomain: "fideliai-app.firebaseapp.com",
    projectId: "fideliai-app",
    storageBucket: "fideliai-app.firebasestorage.app",
    messagingSenderId: "49232775542",
    appId: "1:49232775542:web:e5e5771426462389c5d257"
};

// firebase is a global from the compat SDK script tags
const app = firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage ? firebase.storage() : null;
const firebaseRef = firebase;

// Chiama una callable della region europe-west1 e ritorna direttamente i dati.
async function callFn(name, data = {}) {
    const result = await firebase.app().functions('europe-west1').httpsCallable(name)(data);
    return result.data;
}

export { auth, db, storage, firebaseRef as firebase, callFn };
