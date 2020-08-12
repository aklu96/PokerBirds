const {
    MAX_PLAYERS_PER_GAME,
    NUM_CARDS_PER_PLAYER,
    MAX_BUYIN_IN_CENTS,
    ACTION_ROUNDS,
    NUM_ACTION_ROUND_DEALS,
} = require('./constants');
const {
    toCents,
    toDollars,
    bestHandRank,
    pickBestHandRanks,
    beautifyCard,
    beautifyBoard,
} = require('./utils');
const { Pot } = require('./Pot');

// TODO(anyone): removePlayer
// TODO(anyone): standupPlayer
// TODO(anyone): Create nonce and PokerGame state associated with it.
class PokerGame {
    constructor() {
        // Once buyIn, SB and BB are initialized, will be changed to true.
        this.initialized = false;

        // Below constants should remain the same once initialized. Monetary values are in cents.
        this.buyIn = -1;
        this.smallBlind = -1;
        this.bigBlind = -1;
        this.players = [];

        // Game state variables that change per action & dealer round. Monetary values are in cents.
        this.dealerIdx = 0;
        this.smallBlindIdx = 0;
        this.bigBlindIdx = 0;
        this.turnIdx = 0;
        this.numTurnIncrements = 0;
        // TODO(anyone): Change pot to pots (an array, probably containing playerIdxs that can win that pot). 
        // TODO(anyone): Create an actionRoundPot to display both?
        this.pots = [new Pot(this)];
        // -1 = prev variables uninitialized, 0 = pre-flop, 1 = flop, 2 = turn, 3 = river
        this.actionRound = -1;
        this.board = ['', '', '', '', ''];
        this.deck = [];
        this.minRaise = 0;
        this.previousBet = 0;
        // indicates whether previous action was a check (allowCheck = true), allowing for following player to check.
        // starts this way automatically at beginning of flop, turn, and river. A raise by any player will 
        // toggle the state to false for the rest of the round. Is also toggled for the big blind pre-flop and small blind
        // if SB = BB.
        this.allowCheck = false;
        // assigned during showdown function
        this.winHandRanks = null;
    }

    throwIfNotInitialized() {
        if (!this.initialized) {
            throw new Error(`Haven't initialized buyIn=${toCents(this.buyIn)}, smallBlind=${toCents(this.smallBlind)}` +
                `, bigBlind=${toCents(this.bigBlind)}`);
        }
    }

    /**
     * 1st value that needs to be set. Value has to be <= utils.MAX_BUYIN_IN_CENTS.
     * @param val number potential buy-in in cents
     * @return boolean whether operation succeeded
     */
    setBuyIn(val) {
        if (val < 1 || val > MAX_BUYIN_IN_CENTS) {
            console.error(`Cannot initialize buy-in=${toDollars(val)}. Should be 1 <= val <= ${toDollars(MAX_BUYIN_IN_CENTS)}.`);
            return false;
        }
        this.buyIn = val;
        return true;
    }

    /**
     * 2nd value that needs to be set. Sets the SB. Needs to be set before setting BB.
     * @param val number SB value in cents
     * @return boolean whether operation succeeded
     * TODO(anyone): Add functionality to be able to increase/decrease SB/BB?
     */
    setSmallBlind(val) {
        if (val <= 0) {
            console.error(`Cannot initialize SB with value of ${toDollars(val)}. Value needs to be > 0.`);
            return false;
        }
        if (this.buyIn === -1) {
            console.error(`Cannot initialize SB because buy-in has not been set.`);
            return false;
        }
        if (val > this.buyIn / 20) {
            console.error(`Cannot initialize SB with value greater than buyIn/20.`);
            return false;
        }
        this.smallBlind = val;
        this.bigBlind = -1;
        return true;
    }

    /**
     * 3rd value that needs to be set. Sets the BB. Note, SB and buy-in need to be set first.
     * @param val number potential BB in cents
     * @return boolean whether operation succeeded
     * TODO(anyone): Add functionality to be able to increase/decrease SB/BB?
     */
    setBigBlind(val) {
        if (this.smallBlind === -1) {
            console.error('Cannot initialize BB. Need to initialize SB first.');
            return false;
        }
        if (val < this.smallBlind) {
            console.error('Cannot initialize BB with value less than SB.');
            return false;
        }
        if (val % this.smallBlind !== 0) {
            console.error('Cannot initialize BB. Must be a multiple of SB.');
            return false;
        }
        if (val > this.buyIn / 20) {
            console.error(`Cannot initialize BB with value greater than the buyIn/20.`);
            return false;
        }

        this.bigBlind = val;
        this.initialized = true;
        return true;
    }

    setDealer(idx) {
        if (idx < 0 || idx >= this.totalPlayers) {
            throw new Error(`Cannot set dealer to be ${idx}`);
        }
        this.dealerIdx = idx;
    }

    /**
     * Adds a player to a position, i.e. players array index
     * @param player that will be added
     * @param pos array index where player will be attempted to be placed
     */
    addPlayerToPosition(player, pos) {
        if (this.players[pos] !== undefined) {
            throw new Error(`Cannot add player. Player already sitting at position ${pos}.`);
        }
        if (this.totalPlayers === MAX_PLAYERS_PER_GAME) {
            throw new Error(`Cannot add player. Already have max players (${MAX_PLAYERS_PER_GAME}).`);
        }
        this.players[pos] = player;
    }

    get totalPlayers() {
        return this.players.length;
    }

    get numPlayersInGame() {
        return this.players.reduce((acc, player) => (player.inGame ? acc + 1 : acc), 0);
    }

    get currentPlayer() {
        return this.players[this.turnIdx];
    }

    get dealer() {
        return this.players[this.dealerIdx];
    }

    // create a new full numerically-sorted deck
    buildDeck() {
        this.deck = [];
        // 2, 3, 4, 5, 6, 7, 8, 9, 10, J (11), Q (12), K (13), A (14)
        for (let i = 2; i <= 14; i++) {
            let spadesCard = [i, '♠'], clubsCard = [i, '♣'], diamondCard = [i, '♦'], heartCard = [i, '♥'];
            this.deck.push(spadesCard, clubsCard, diamondCard, heartCard);
        }
    }

    // increment turn and loop around the table if necessary
    incrementTurn() {
        this.throwIfNotInitialized();
        this.numTurnIncrements++;

        this.turnIdx++;
        this.turnIdx %= this.totalPlayers;
    }

    /**
     * Increment turn to the next player still in the game.
     * @returns array of players who were skipped either bcz they were out of the game or all-in
     */
    incrementTurnToNextPlayerInGame() {
        this.throwIfNotInitialized();

        this.incrementTurn();
        const skipped = [];
        // Iterates starting from the current turn until it finds the next player that hasn't folded,
        // then breaks the loop
        for (let i = 0; i < this.totalPlayers; i++) {
            if (!this.currentPlayer.inGame || this.currentPlayer.isAllIn) {
                skipped.push(this.currentPlayer);
                this.incrementTurn();
            } else {
                break;
            }
        }
        return skipped;
    }

    // assign 2 cards from the deck to each player
    // only needs to run once at the beginning of each dealer round
    dealCards() {
        this.players
            .filter((player) => player.inGame)
            .forEach((player) => {
                for (let i = 0; i < NUM_CARDS_PER_PLAYER; i++) {
                    let randInt = this.randDeckIdx();
                    player.cards[i] = this.deck[randInt];
                    this.deck.splice(randInt, 1);
                }
            });
    }

    // TODO(anyone): Check that players are inGame or not before having them post blinds
    postBlinds() {
        this.throwIfNotInitialized();

        // post small blind
        this.minRaise = 0;
        this.previousBet = 0;
        this.currentPlayer.raise(this.smallBlind);
        this.currentPlayer.actionState = 'SB';
        this.smallBlindIdx = this.currentPlayer.id;
        this.incrementTurnToNextPlayerInGame();

        // post big blind; vars are set to 0 to allow a raise (so that later bb can check at the end of pre-flop)
        this.minRaise = 0;
        this.previousBet = 0;
        this.currentPlayer.raise(this.bigBlind);
        this.currentPlayer.actionState = 'BB';
        this.bigBlindIdx = this.currentPlayer.id;
        this.incrementTurnToNextPlayerInGame();
        this.minRaise = this.bigBlind;
        this.previousBet = this.bigBlind;
        this.allowCheck = false;
    }

    callCurrentPlayerAction(result) {
        switch (result.playerAction) {
            case 'all-in':
                if (!this.currentPlayer.inGame) {
                    throw new Error(`Current player (id: ${this.currentPlayer.id}) cannot fold bcz player not in game.`);
                }
                this.currentPlayer.allIn();
                break;
            case 'call':
                if (!this.canCurrentPlayerCall()) {
                    throw new Error(`Current player (id: ${this.currentPlayer.id}) cannot call`);
                }
                this.currentPlayer.call();
                break;
            case 'raise':
                if (!this.canCurrentPlayerRaise()) {
                    throw new Error(`Current player (id: ${this.currentPlayer.id}) cannot raise`);
                }
                if (!this.canCurrentPlayerRaiseBy(result.raiseAmount)) {
                    throw new Error(`Current player (id: ${this.currentPlayer.id}) cannot raise by ${result.raiseAmount}`);
                }
                this.currentPlayer.raise(result.raiseAmount);
                break;
            case 'fold':
                if (!this.currentPlayer.inGame) {
                    throw new Error(`Current player (id: ${this.currentPlayer.id}) cannot fold bcz player not in game.`);
                }
                this.currentPlayer.fold();
                break;
            case 'check':
                if (!this.canCurrentPlayerCheck()) {
                    throw new Error(`Current player (id: ${this.currentPlayer.id}) cannot check`);
                }
                this.currentPlayer.check();
                break;
            default:
                throw new Error(`Illegal argument: result=${JSON.stringify(result)}`);
        }
    }

    get currentNonRaiseActionStates() {
        return this.players.reduce((acc, player) => (player.actionState !== 'raise' ? acc + 1 : acc), 0);
    }

    // During pre-flop, BB player (and SB player if this.smallBlind === this.bigBlind) has the option
    // to check if all other players called or folded.
    preflopAllowCheckForSBAndOrBB() {
        this.validateInActionRound('pre-flop');

        // Make this.allowCheck = true for SB's turn if:
        //  - it's SB's turn
        //  - this.smallBlind === this.bigBlind
        //  - no one else (other than SB & BB) has raised
        if (this.currentPlayer.actionState === 'SB' && this.smallBlind === this.bigBlind
            && this.currentNonRaiseActionStates === this.totalPlayers) {
            this.allowCheck = true;
        }

        // Make this.allowcheck = true for BB if:
        //  - it's BB's turn
        //  - this.smallBlind !== this.bigBlind - in which case it has already been toggled
        //  - no one else (other than SB & BB) has raised in action round
        // edge case: big blind re-raised and all other players called.
        // TODO(anyone): Not sure if this is a TODO still or not? ^^
        if (this.currentPlayer.actionState === 'BB' && this.smallBlind !== this.bigBlind
            && this.currentNonRaiseActionStates === this.totalPlayers) {
            this.allowCheck = true;
        }
    }

    addToBoard = () => {
        this.throwIfNotInitialized();

        let randInt = this.randDeckIdx();
        for (let i = 0; i < 5; i++) {
            if (this.board[i] === '') {
                this.board[i] = this.deck[randInt];
                this.deck.splice(randInt, 1);
                return;
            }
        }
    }

    burn() { // lol
        this.validateNotInActionRound('pre-flop');
        this.deck.splice(this.randDeckIdx(), 1);
    }

    flop() {
        this.validateInActionRound('flop');
        this.burn();
        this.addToBoard();
        this.addToBoard();
        this.addToBoard();
    };

    turn() {
        this.validateInActionRound('turn');
        this.burn();
        this.addToBoard();
    }

    river() {
        this.validateInActionRound('river');
        this.burn();
        this.addToBoard();
    }

    get actionRoundStr() {
        return ACTION_ROUNDS[this.actionRound];
    }

    get allInPlayersCounter() {
        return this.players.reduce((acc, player) => (player.isAllIn ? acc + 1 : acc), 0);
    }

    get allInPlayers() {
        return this.players.filter((player) => player.isAllIn);
    }

    organizePotsAfterRoundEnded() {
        if (!this.dealerRoundEnded() && !this.actionRoundEndedViaAllInScenario() && !this.actionRoundEnded()) {
            throw new Error(`Round has not ended. Cannot organize pots.`);
        }

        this.pots
            .filter((pot) => pot.open)
            .forEach((pot) => {
                if (pot.hasAllInPlayer()) {
                    pot.open = false;
                }
                pot.prevARsAmount += pot.currARAmount;
                pot.currARAmount = 0;
                pot.playerCommitment = 0;
                pot.history = new Map();
            });
    }

    /**
     * Finish action rounds for current dealer round by calling this.flop(), this.turn() and this.river().
     * Start from the earliest possible method.
     */
    finishActionRounds() {
        if (!this.actionRoundEndedViaAllInScenario()) {
            throw new Error('ActionRound has not ended via an all-in scenario.');
        }
        this.validateNotInActionRound('river');

        if (this.actionRoundStr === 'pre-flop') {
            this.actionRound++;
        }

        let numDealingsRemaining = NUM_ACTION_ROUND_DEALS - this.actionRound;
        for (let i = 0; i <= numDealingsRemaining; i++) {
            this[this.actionRoundStr](); // call the current actionRoundStr, e.g. this["flop"]()
            this.actionRound++;
        }
        this.actionRound = 3; // set current actionRound to be river, as the above for-loop increments it to 4
    }

    get noRaiseScenarioCounter() {
        let counter = 0;
        this.players
            .filter((player) => player.inGame)
            // handles both pre-flop and post-flop "no raise" situations
            .forEach((player) => {
                // if player is all-in, AND,
                //   - if player's actionState is 'call' => player has definitely not raised
                //   - if player doesn't have an actionState, it means they're in this round from having gone all in
                //     from a previous action round
                // if the above is met, the player hasn't raised => count them in the no-raise scenario count
                if (player.isAllIn && (player.actionState === 'call' || player.actionState === ' ')) {
                    counter++
                // if player has called AND they're NOT all-in, make sure they're in all open pots
                //   - if they aren't, that means they still have room to call, and haven't called the current raise yet
                //   - if they have called every open pot, count them in the no-raise scenario count
                } else if (player.actionState === 'call' && !player.isAllIn) {
                    if (this.pots.filter((pot) => pot.open).every((pot) => pot.hasPlayerInPotentialWinners(player.id))) {
                        counter++;
                    }
                // if player is in check actionState, make sure everyone else inGame has checked to add a no-raise scenario count
                } else if (player.actionState === 'check') {
                    if (this.players.filter((player) => player.inGame).every((player) => player.actionState === 'check')) {
                        counter++;
                    }
                }
            });
        return counter;
    }

    get raiseScenarioCounter() {
        return this.players.filter((player) => player.inGame)
            .reduce((acc, player) => player.actionState === 'raise' ? acc + 1 : acc, 0);
    }

    preFlopActionRoundEnded() {
        return this.actionRoundStr === 'pre-flop' && (
                // if SB === BB, all players that aren't the SB or BB should have called, AND SB should have checked and BB should have checked
                (this.smallBlind === this.bigBlind && this.players.filter((player) => player.inGame && player.id !== this.bigBlindIdx && player.id !== this.smallBlindIdx).every((player) => player.actionState === 'call') && this.players[this.smallBlindIdx].actionState === 'check' && this.players[this.bigBlindIdx].actionState === 'check')
                // if SB !== BB, all players that aren't BB should have called, and BB should have checked
            ||  (this.smallBlind !== this.bigBlind && this.players.filter((player) => player.inGame && player.id !== this.bigBlindIdx).every((player) => player.actionState === 'call') && this.players[this.bigBlindIdx].actionState === 'check')
        );
    }

    /**
     * @returns true if:
     *  - certain pre-flop conditions are met
     *  - no one has raised and everyone has played (i.e. called, checked or were already all-in) OR
     *  - only currentPlayer has raised AND everyone else that's in the game has either folded or checked or was already all-in
    */
    actionRoundEnded() {
        return this.preFlopActionRoundEnded()
            // if no one raised
            || this.noRaiseScenarioCounter === this.numPlayersInGame
            // OR someone raised
            || (this.raiseScenarioCounter === 1 && this.currentPlayer.actionState === 'raise');
            // TODO: Raise all-in, then subsequent raise isn't probably considered here.
    }

    /**
     * @returns true if
     *   - everyone is all-in, OR
     *   - everyone except one player is all-in; that player should be in every Pot's potentialWinners Set
     */
    actionRoundEndedViaAllInScenario() {
        this.throwIfNotInitialized();
        if (this.allInPlayersCounter === this.numPlayersInGame) {
            return true;
        }

        if (this.allInPlayersCounter === this.numPlayersInGame - 1) {
            let player = this.players.find(player => player.inGame && !player.isAllIn);
            return this.pots.every((pot) => pot.playerIdxInPotentialWinners(player.id));
        }

        return false;
    }

    /**
     * Idempotent method. Action round ending conditions fall into two categories:
     *  1. "No-raise": where there has been no raise and everyone checks or folds, or in the case of the pre-flop,
     *     calls, checks, or folds.
     *  2. "Raise": where there is one remaining raiser and everyone else behind calls or folds.
     * @returns { scenario: "raise" or "no-raise" }
     */
    getActionRoundInfo() {
        this.throwIfNotInitialized();
        if (!this.actionRoundEnded()) {
            throw new Error(`Action round hasn't ended.`);
        }

        // can be combined later
        if (this.preFlopActionRoundEnded() || this.noRaiseScenarioCounter === this.numPlayersInGame) {
            return { scenario: 'no-raise' }; // free cards smh cod clam it
        }

        return { scenario: 'raise' }; // no free cards baby!
    }

    // Idempotent method. Returns true if everyone except one person has folded, i.e. if the dealer round ended
    dealerRoundEnded() {
        let outOfGame = 0;
        this.players.forEach((player) => {
            if (player.actionState === 'fold' || player.actionState === '') {
                outOfGame++;
            }
        });
        return outOfGame === this.totalPlayers - 1;
    }

    /**
     * End dealer round if everyone except 1 person folded. Assign pot to that person (i.e. the winner). No showdown.
     *
     * This is one of three ways a dealer round can end. The other two are
     *   (1) all-in scenario and
     *   (2) river action round ending
     * The above 2 are handled by separate functions.
     * @returns {
     *    winnerIdx (optional number): index of player that won the dealer round,
     *    winnings (optional number): pot winnings (in cents)
     * }
     */
    getDealerRoundInfoAndAssignWinnings() {
        this.throwIfNotInitialized();
        if (!this.dealerRoundEnded()) {
            throw new Error(`Dealer round hasn't ended.`);
        }

        if (this.pots.length > 1) {
            console.warn(`Somehow, there are ${this.pots.length} pots. Is this OK?`);
        }

        // move pot to winner's stack. there should only be one pot because everyone folded except one person
        let winner = this.players.find((player) => player.inGame);
        let winnings = this.pots.reduce((acc, pot) => acc + pot.prevARsAmount, 0);
        winner.stack += winnings;
        this.resetPots();
        return { winnerIdx: winner.id, winnings };
    }

    resetPots() {
        this.pots = [new Pot(this)];
    }

    /**
     * start the following action round
     * @returns players skipped to begin action round
     */
    refreshAndIncActionRound() {
        this.validateNotInActionRound('river', 'Cannot refresh and increment action round consecutively more than 4' +
            'times without calling refreshDealerRound.');
        this.validateNotInActionRound('uninitialized', `Must call refreshDealerRound before calling refreshAndIncActionRound.`);

        // clear pot commitment and action states; cards remain the same; reset this.minRaise; allow check
        this.players.forEach((player) => {
            player.potCommitment = 0;
            player.actionState = '';
            player.allowRaise = true;
        });
        this.previousBet = 0;
        this.minRaise = this.bigBlind;
        this.allowCheck = true;

        // action rounds begin with the first player in the game AFTER the dealerIdx
        this.turnIdx = this.dealerIdx;
        const skipped = this.incrementTurnToNextPlayerInGame();

        // hacky way of setting players to still be in the action round so that the ending condition
        // functions don't immediately read the turn as over at the beginning of the round (could probably
        // be improved to be more clear). Still a blank string so that nothing is output to the board
        this.players.forEach((player) => {
            if (player.inGame) {
                player.actionState = ' ';
            }
        });
        
        this.actionRound++;
        return skipped;
    }

    /**
     * Restart the following dealer round.
     * @returns { gameEnded: boolean = whether game ended if there's only 1 person left that won all the $ }
     */
    refreshDealerRound() {
        this.throwIfNotInitialized();

        this.actionRound = 0;
        this.winHandRanks = null;
        this.resetPots();
        this.players.forEach((player) => {
            player.cards = [null, null];
            player.actionState = '';
            player.potCommitment = 0;
            player.inGame = true;
            player.allowRaise = true;
            player.isAllIn = false;
            player.showdownRank = null;

            // If a player lost their money, they stay out. Can clear them out completely later.
            // Doesn't really matter though because browser version will have option to buy back in, leave, etc.

            if (player.stack === 0 || player.stack < this.bigBlind) {
                player.inGame = false;
            }
        });

        // clear the board, build a new full deck, and deal cards to the players
        this.board = ['', '', '', '', ''];
        this.buildDeck();
        this.dealCards();

        if (this.numPlayersInGame <= 1) {
            return { gameEnded: true };
        }

        // increment dealer and loop around players array until we find a player inGame
        for (let i = 0; i < this.totalPlayers; i++) {
            this.dealerIdx++;
            this.dealerIdx %= this.totalPlayers;

            if (this.players[this.dealerIdx].inGame) {
                break;
            }
        }

        // Commented out the below to push to GitHub without this assertion
        // // TODO: Remove once confirmed works and add as test
        // let TOTAL_MONEY_IN_GAME = toCents(3100);
        // let actualTotalMoney = this.players.reduce((acc, player) => acc + player.stack, 0);
        // if (TOTAL_MONEY_IN_GAME !== actualTotalMoney) {
        //     throw new Error(`Clammit. We lost money somewhere: TOTAL_MONEY_IN_GAME=${toDollars(TOTAL_MONEY_IN_GAME)}, `
        //         + `but actualTotalMoney=${actualTotalMoney}.`);
        // }

        // set turn to dealer, increment turn to next player in game, and post blinds
        this.turnIdx = this.dealerIdx;
        this.incrementTurnToNextPlayerInGame();
        this.postBlinds();

        // edge case scenario where there are only 2 players and sb = bb, first player to act is sb
        // and this allows them to check
        if (this.currentPlayer.actionState === 'SB' && this.smallBlind === this.bigBlind) {
            this.allowCheck = true;
        }

        return { gameEnded: false };
    }

    /**
     * For each pot, determine which players won and how much. Add winnings to each player's stack.
     * @returns array of objects built from each pot
     *   [
     *     {
     *        winnings: how much each player won,
     *        winners: [winning player indexes]
     *     }, ...
     *   ]
     */
    getShowdownInfoAndAssignWinnings() {
        this.validateInActionRound('river');

        // TODO: Check if the last pot has only one player and assign to the player before making it a pot to check hands for
        if (this.actionRoundEndedViaAllInScenario()) { /* TODO implementation of the above in here */}

        // for each player in game, get their bestHandRank and assign to player.showdownRank
        this.players.forEach((player, idx) => {
            if (player.inGame) {
                let sevenCards = [...this.board, ...player.cards];

                // take player's seven showdown cards and return the rank of the best five cards
                player.showdownRank = bestHandRank(sevenCards);
                player.showdownRank.playerIndex = idx; // just for you AK ;)
            }
        });

        // for each Pot's potentialWinners Set:
        //  - get each potential winner's bestHandRank (player.showdownRank)
        //  - pick the best players' showdownRank
        //  - assign to pot.winHandRanks array
        this.pots.forEach((pot) => {
            let potShowdownRanks = Array.from(pot.potentialWinners.values()).map((pIdx) => this.players[pIdx].showdownRank);
            pot.winHandRanks = pickBestHandRanks(potShowdownRanks);
        });

        let result = [];

        // for each pot, divide its amount by the winHandRanks' length and add that fraction to each winner
        // as you're doing the above, build up the result array that will be returned
        this.pots.forEach((pot) => {
            // add pot / numWinners to every winner, reset pot
            let winnings = pot.prevARsAmount / pot.winHandRanks.length;
            let resultObj = { winnings, winners: [] };
            result.push(resultObj);

            pot.winHandRanks.forEach((rank) => {
                this.players[rank.playerIndex].stack += winnings;
                resultObj.winners.push(rank.playerIndex);
            });
        })

        this.resetPots();
        return result;
    }

    canCurrentPlayerCheck() {
        this.throwIfNotInitialized();
        return this.allowCheck;
    }

    canCurrentPlayerCall() {
        this.throwIfNotInitialized();

        // validate that there is a raise on the board to be called. Second part is to allow the SB to call
        // when it is not equal to the big blind
        let raiseCounter = 0;
        for (let i = 0; i < this.totalPlayers; i++) {
            // this allows the small blind to call big blind as well
            if (this.players[i].actionState === 'raise' || this.players[i].actionState === 'SB') {
                raiseCounter++;
            }
        }

        // exception for situation where small blind is equal to big blind; SB cannot call there
        if (raiseCounter === 0 || this.currentPlayer.actionState === 'SB' && this.smallBlind === this.bigBlind) {
            return false;
        } else {
            return true;
        }
    }

    canCurrentPlayerRaise() {
        this.throwIfNotInitialized();
        return this.currentPlayer.allowRaise;
    }

    canCurrentPlayerRaiseBy(cents) {
        this.throwIfNotInitialized();

        // check all-in edge case scenarios
        //   1. When there was a previous player that went all in but their raise wasn't enough to cover the minRaise
        //   2. If raise is an all-in
        if (!this.currentPlayer.allowRaise) {
            return false;
        } else if (cents === this.currentPlayer.stack) {
            return true;
        }

        // verify that the raise is an increment of the small blind, equal or above the minimum raise,
        // and less than or equal to the player's stack. exception is made if player bets stack; then bet gets through
        // regardless of the min raise.
        if (cents % this.smallBlind !== 0
            || cents < this.previousBet + this.minRaise
            || cents > this.currentPlayer.stack + this.currentPlayer.potCommitment) {
            return false;
        }

        return true;
    }

    randDeckIdx() {
        return Math.floor(Math.random() * this.deck.length);
    }

    validateInActionRound(event, errMsg) {
        this.throwIfNotInitialized();
        if (this.actionRoundStr !== event) {
            errMsg = errMsg || `Cannot ${event} at this point in the game.`;
            throw new Error(errMsg);
        }
    }

    validateNotInActionRound(event, errMsg) {
        this.throwIfNotInitialized();
        if (this.actionRoundStr === event) {
            errMsg = errMsg || `Cannot ${event} at this point in the game.`;
            throw new Error(errMsg);
        }
    }

    toString() {
        let str = `PokerGame {\n` +
        `  initialized: ${this.initialized},\n` +
        `  buyIn: ${toDollars(this.buyIn)},\n` +
        `  smallBlind: $${toDollars(this.smallBlind)},\n` +
        `  smallBlindIdx: ${this.smallBlindIdx},\n` +
        `  bigBlind: $${toDollars(this.bigBlind)},\n` +
        `  bigBlindIdx: ${this.bigBlindIdx},\n` +
        `  dealerIdx: ${this.dealerIdx},\n` +
        `  turnIdx: ${this.turnIdx},\n` +
        `  pot: ${this.pots.map((pot, idx) => {
            return ` ${idx}: ${pot.toString()}\n`
        }).join('')},\n` +
        `  actionRoundStr: ${this.actionRoundStr},\n` +
        `  board: ${beautifyBoard(this.board)},\n` +
        `  minRaise: $${toDollars(this.minRaise)},\n` +
        `  previousBet: $${toDollars(this.previousBet)},\n` +
        `  allowCheck: ${this.allowCheck},\n`;

        let deckStr = `  deck: ${this.deck.map((card, idx) => {
            if (idx === 0) {
                return '[\n    ' + beautifyCard(card) + ', ';
            } else if (idx === this.deck.length - 1) {
                return beautifyCard(card) + '\n  ],\n';
            } else {
                return beautifyCard(card) + ', ';
            }
        }).join('')}`;

        let playerStr = `  players: ${this.players.map((player, idx) => {
            if (idx === 0) {
                return '[\n    ' + player.toString() + ',\n';
            } else if (idx === this.players.length - 1) {
                return '   ' + player.toString() + '\n  ]';
            } else {
                return '   ' + player.toString() + ',\n';
            }
        })}`;

        return str + deckStr + playerStr + '\n}';
    }
}

module.exports = {
    PokerGame,
};
