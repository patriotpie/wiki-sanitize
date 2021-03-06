var data = require("sdk/self").data;
var pageMod = require("sdk/page-mod");
var pageWorker = require("sdk/page-worker");
var tabs = require("sdk/tabs");
var panel = require("sdk/panel");

var interestingPhrases = [

	{
		"re": "pa(y|ying|id|yment)",
		"desc": "pay/paying/paid/payment"
	},

	{
		"re": "compensat(e|ed|ion|ing)",
		"desc": "compensate/compensated/compensation/compensating"
	},

	{
		"re": "hire(d|s|ing)?",
		"desc": "hire/hired/hires/hiring"
	},

	{
		"re": "disclos(e|ed|ure|ing)",
		"desc": "disclose/disclosed/disclosure/disclosing"
	},
	
	{
		"re": "contribut(e|ed|ion|ing)",
		"desc": "contribute/contibuted/contribution/contributing"
	},

	{
		"re": "affiliat(e|ed|ion)",
		"desc": "affiliate/affiliated/affiliation"
	},

	{
		"re": "client(ele)?",
		"desc": "client/clientele"
	},
	
	{
		"re": "employ(ee|er|ed|ing)?",
		"desc": "employ/employee/employer/employed/employing"
	},

	{
		"re": "work(s|ed|ing)?",
		"desc": "work/works/worked/working"
	}

];


var workersManager = (function() {

	// getEditorsWorker gets the editors from toolserver.org of the page whose title is given by wiki-sanitize.pageTitle
	// when the editorsArray is ready, callback(editorsArray) is called
	var getEditorsWorker = function(pageTitle, callback) {

		let worker = pageWorker.Page({
			contentScriptFile: data.url("get-editors.js"),
			contentURL: "https://toolserver.org/~daniel/WikiSense/Contributors.php?wikifam=.wikipedia.org&wikilang=en&order=-edit_count&page="+pageTitle+"&grouped=on&ofs=0&max=1000"
		});

		worker.port.emit("getEditors");
		worker.port.on("editorsReady", function(editorsArray) {
			callback(editorsArray, null);
		});
		worker.port.on("editorsError", function(e) {
			callback(null, e);
		});

		return worker; // for destruction later
	}

	//TODO: make limit variable
	// getEditSummariesWorker returns non-auto-generated summaries of the current page
	var getEditSummariesWorker = function(pageTitle, callback) {

		// TODO: get-edit-summaries.js should extract the interesting ones so that we don't pass
		// the whole kit and caboodle back and forth. We should be passing it interesting-phrases
		let worker = pageWorker.Page({
			contentScriptFile: data.url("get-edit-summaries.js"),
			contentURL: "https://en.wikipedia.org/w/index.php?title="+pageTitle+"&offset=20150101000000&limit=1000&action=history"
		});

		worker.port.emit("getEditSummaries", interestingPhrases);
		worker.port.on("editSummariesReady", function(editSumsArray) {
			callback(editSumsArray, null);
		});
		worker.port.on("editSummariesError", function(e) {
			callback(null, e);
		});

		return worker; // for destruction later
	}

	// getUserPageWorker is spawned for each individual editor
	// The worker is tasked with extracting interesting info, which is then
	// passed to the callback
	// The function returns a handle to the worker for cleanup
	var getUserPageWorker = function(editor, callback) {

		let worker = pageWorker.Page({
			contentScriptFile: data.url("get-user-page-snippets.js"),
			contentURL: "https://en.wikipedia.org/wiki/User:" + editor
		});

		worker.port.emit("getUserPageSnippets", interestingPhrases);
		worker.port.on("userPageSnippetsReady", function(snippets) {
			callback(snippets, null, editor);
		});
		worker.port.on("userPageSnippetsError", function(e) {
			callback(null, e, editor);
		});

		return worker;
	}

	// getTalkPageWorker spawns a pageWorker that loads the talk page for pageTitle
	// and extracts interesting info using an attached content script
	// and passes it to the callback
	// The functions returns a handle to the worker for cleanup
	var getTalkPageWorker = function(pageTitle, callback) {

		let worker = pageWorker.Page({
			contentScriptFile: data.url("get-talk-page-snippets.js"),
			contentURL: "https://en.wikipedia.org/wiki/Talk:" + pageTitle
		});

		worker.port.emit("getTalkPageSnippets", interestingPhrases);
		worker.port.on("talkPageSnippetsReady", function(snippets) {
			callback(snippets, null);
		});
		worker.port.on("talkPageSnippetsError", function(e) {
			callback(null, e);
		});

		return worker;
	}


	return {
		getEditorsWorker: getEditorsWorker,
		getEditSummariesWorker: getEditSummariesWorker,
		getUserPageWorker: getUserPageWorker,
		getTalkPageWorker: getTalkPageWorker,
	};


}());



var getMoney = function(title, wikiWorker) {
	// getMoney will download the pages for the edit history and the find most active contributors to a page
	// then it will make this information accesible to the user to determine the trustworthiness of a page

	var wikiPageTab = wikiWorker.tab;
	var editors = [];
	var summaries = [];
	var workers = [];

	workers.push({
		worker: wikiWorker,
		name: "wikiWorker",
		flag: false
	});


	
	// alertWorker exists for debugging purposes
	let alertWorker = wikiPageTab.attach({
		contentScript: "self.port.on(\"alert\", function(msg) { window.alert(msg); });"
	});

	// Called in CB funcs below - basically we define CBs that execute when workers have done their job
	// At the end of the CB, the worker is flagged for deletion using the two functions below
	var flagWorkerForDeletion = function(workerName) {
		for (var i = 0; i < workers.length; i++) {
			if (workers[i].name == workerName) {
				workers[i].flag = true;
				break;
			}
		}
	}

	var cleanupWorkers = function() {
		for (var i = workers.length - 1; i >= 0; i--) {
			if (workers[i].flag) {
				workers[i].worker.destroy();
				// alertWorker.port.emit("alert", "Destroyed worker: " + workers[i].name);
				workers.splice(i, 1);
			}
		}
	}



	// First things first: remove the pageMod that we spawned from
	flagWorkerForDeletion("wikiWorker");
	cleanupWorkers();

	// Next, define the panel that will display to the user the findings for the current page
	// We want this to only be displayed when the active tab matches the page the user
	// navigated to initially, so we handle that after defining the panel below
	var infoPanel = panel.Panel({
		
		width: 380,
		height: 240,

		position: {
			bottom: 20,
			right: 40
		},

		contentURL: data.url("panel.html"),

		contentScriptFile: data.url("panel.js")
	});

	infoPanel.port.on("tabOpen", function(reqUrl) {
		tabs.open({
			url: reqUrl,
			inBackground: true
		});
	});

	var buildPanelAndDisplay = function() {
		infoPanel.port.emit("buildContentView");
		infoPanel.show();
	}

	tabs.on("activate", function(activatedTab) {
		if (activatedTab == wikiPageTab) {
			buildPanelAndDisplay();
		}
		else {
			infoPanel.hide();
		}
	});

	// processEditors is called once a pageWorker has determined who the most active editors are
	// for the page that the user has navigated to
	// processEditors spawns pageWorkers to pull the user pages of these editors and extracts
	// "interesting" snippets by testing against the array of "interestingPhrases" above
	var processEditors = function() {
		infoPanel.port.emit("clearInterestingUserPageSnippets");
		//alertWorker.port.emit("alert", "Instantiating " + Math.min(5, editors.length).toString() + " new workers");
		for (var i = 0; i < Math.min(5, editors.length); i++) {

			let userPageWorker = workersManager.getUserPageWorker(editors[i], function(snippets, err, editor) {

				if (err === null) {
					infoPanel.port.emit("appendInterestingUserPageSnippets", {
						user: editor,
						content: snippets
					});
					if (tabs.activeTab == wikiPageTab) {
						buildPanelAndDisplay();
					}
				}
				else {
					alertWorker.port.emit("alert", editor + " user page error: " + err);
				}

				// If this cb has been called, this worker has done its job - flag it for deletion
				//alertWorker.port.emit("alert", "User worker userPageWorker" + editor + " finshed");
				flagWorkerForDeletion("userPageWorker" + editor);
				cleanupWorkers();
			});
			workers.push({
				worker: userPageWorker,
				name: "userPageWorker" + editors[i],
				flag: false
			});
		}
	}


	var editorListPageWorker = workersManager.getEditorsWorker(title, function(editorList, err) {
		if (err === null) {
			editors = editorList;
			//alertWorker.port.emit("alert", editors[0]);
		}
		else {
			alertWorker.port.emit("alert", "Editors retrieval error: " + err);
		}

		// Flag this worker for GC
		flagWorkerForDeletion("editorListPageWorker");
		cleanupWorkers();

		// Carry on processing editor pages
		processEditors();
	});
	workers.push({
		worker: editorListPageWorker,
		name: "editorListPageWorker",
		flag: false
	});


	var editSummariesPageWorker = workersManager.getEditSummariesWorker(title, function(summariesList, err) {
		if (err === null) {
			infoPanel.port.emit("setInterestingEditSummaries", summariesList);
			if (tabs.activeTab == wikiPageTab) {
				buildPanelAndDisplay();
			}

		}
		else {
			alertWorker.port.emit("alert", "Edit summary retrieval error: " + err);

		}

		// Flag this worker for GC
		flagWorkerForDeletion("editSummariesPageWorker");
		cleanupWorkers();
	});
	workers.push({
		worker: editSummariesPageWorker,
		name: "editSummariesPageWorker",
		flag: false
	});
	
	var talkPageWorker = workersManager.getTalkPageWorker(title, function(talkPageSnippets, err) {
		if (err === null) {
			infoPanel.port.emit("setInterestingTalkPageSections", {
				articleName: title,
				content: talkPageSnippets
			});
			if (tabs.activeTab == wikiPageTab) {
				buildPanelAndDisplay();
			}
		}
		else {
			alertWorker.port.emit("alert", "Talk page retrieval error: " + err);
		}
		
		// Flag this worker for GC
		flagWorkerForDeletion("talkPageWorker");
		cleanupWorkers();
	});
	workers.push({
		worker: talkPageWorker,
		name: "talkPageWorker",
		flag: false
	});

}



// Sloppily use pageMod to inject the addon to all wikipedia pages
pageMod.PageMod({

	// Exclude special wikipedia pages, we don't need to fact-check these
	include: /.*\.wikipedia.org\/wiki\/(?!Talk:|User:|User_talk:|Wikipedia:|Wikipedia_talk:|File:|File_talk:|MediaWiki:|MediaWiki_talk:|Template:|Template_talk:|Help:|Help_talk:|Category:|Category_talk:|Portal:|Portal_talk:|Book:|Book_talk:|Draft:|Draft_talk:|Education_Program:|Education_Program_talk:|TimedText:|TimedText_talk:|Module:|Module_talk:|Special:|Media:).*/,
	contentScriptFile: data.url("get-page-title.js"),
	contentScriptWhen: "ready",

	onAttach: function(worker) {
		worker.port.emit("resolvePageTitle");

		worker.port.on("titleResolved", function(pageTitle) {
			getMoney(pageTitle, worker);
		});
	}
});




tabs.open("http://en.wikipedia.org/wiki/ExxonMobil");
